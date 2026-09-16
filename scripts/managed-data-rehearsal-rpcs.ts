import assert from "node:assert/strict";

type ClaimInput = {
  userId: string;
  dedupeKey: string;
  now: Date;
  windowMs: number;
  maxPerWindow: number;
};

type QuoteValues = {
  addressNormalized: string;
  addressDisplay: string;
  status: string;
  policyType: string;
  quotes: never[];
  triggeredAt: Date;
  expiresAt: Date;
};

let identifierSequence = 0;

function raceIdentifier(label: string): string {
  identifierSequence += 1;
  return `fake-rehearsal-race-${process.pid}-${identifierSequence}-${label}`;
}

async function waitForBlockedTableRequest(
  target: import("pg").Pool,
  table: "ifw_activity_claims" | "insurance_quote_cache",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await target.query<{ waiting: number }>(
      `select count(*)::int as waiting
         from pg_locks
        where relation = $1::regclass
          and not granted`,
      [table],
    );
    if (Number(result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`No PostgREST transaction contended on ${table}`);
}

async function runBehindTableBarrier<T>(
  target: import("pg").Pool,
  table: "ifw_activity_claims" | "insurance_quote_cache",
  work: () => Promise<T>,
): Promise<T> {
  const blocker = await target.connect();
  let transactionOpen = false;
  let pending: Promise<T> | undefined;
  try {
    await blocker.query("begin");
    transactionOpen = true;
    await blocker.query(`lock table ${table} in access exclusive mode`);
    pending = work();
    await waitForBlockedTableRequest(target, table);
    await blocker.query("commit");
    transactionOpen = false;
    return await pending;
  } finally {
    if (transactionOpen) await blocker.query("rollback");
    blocker.release();
    // Observe a rejection even when establishing the barrier itself failed.
    if (pending && transactionOpen) await pending.catch(() => undefined);
  }
}

function counts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function quoteValues(
  address: string,
  policyType: "HO3" | "HO6",
  now: Date,
  status = "pending",
): QuoteValues {
  return {
    addressNormalized: address,
    addressDisplay: `${address}.invalid`,
    status,
    policyType,
    quotes: [],
    triggeredAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };
}

export async function testClaimRaces(
  t: import("node:test").TestContext,
  target: import("pg").Pool,
): Promise<void> {
  assert.equal(process.env.MANAGED_DATA_MODE, "supabase-read");
  assert.match(process.env.VITE_SUPABASE_URL ?? "", /^http:\/\/127\.0\.0\.1:/);
  assert.equal(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    "synthetic-rehearsal-key",
  );
  assert.match(
    process.env.REHEARSAL_SOURCE_URL ?? "",
    /(?:\/|%2F)rehearsal_source(?:\?|$)/,
  );
  const database = await target.query<{ current_database: string }>(
    "select current_database()",
  );
  assert.equal(database.rows[0]?.current_database, "rehearsal_target");

  // Importing these modules can initialize database and HTTP clients. Keep the
  // imports after all synthetic-environment checks above.
  const { SupabaseIfwActivityClaimStore } = await import(
    "../server/integrations/ifw-activity-claims"
  );
  const {
    claimNewQuoteCache,
    readQuoteCache,
    reclaimQuoteCache,
  } = await import("../server/managed-quote-cache");
  const store = new SupabaseIfwActivityClaimStore();
  const { Pool } = await import("pg");
  const source = new Pool({
    connectionString: process.env.REHEARSAL_SOURCE_URL,
    max: 1,
  });
  const sourceMarker = `fake-rehearsal-race-${process.pid}-%`;
  const sourceCounts = async () => {
    const result = await source.query<{ ifw: number; quotes: number }>(
      `select
         (select count(*)::int from ifw_activity_claims
           where dedupe_key like $1) as ifw,
         (select count(*)::int from insurance_quote_cache
           where address_normalized like $1) as quotes`,
      [sourceMarker],
    );
    return result.rows[0];
  };
  assert.deepEqual(await sourceCounts(), { ifw: 0, quotes: 0 });
  t.after(async () => {
    try {
      assert.deepEqual(
        await sourceCounts(),
        { ifw: 0, quotes: 0 },
        "supabase-read claim wrappers must not write the source database",
      );
    } finally {
      await source.end();
    }
  });
  t.after(async () => {
    await target.query(
      "delete from ifw_activity_claims where dedupe_key like $1",
      [sourceMarker],
    );
    await target.query(
      "delete from insurance_quote_cache where address_normalized like $1",
      [sourceMarker],
    );
    const remaining = await target.query<{ ifw: number; quotes: number }>(
      `select
         (select count(*)::int from ifw_activity_claims
           where dedupe_key like $1) as ifw,
         (select count(*)::int from insurance_quote_cache
           where address_normalized like $1) as quotes`,
      [sourceMarker],
    );
    assert.deepEqual(remaining.rows[0], { ifw: 0, quotes: 0 });
  });

  await t.test("IFW claims serialize duplicate contenders", {
    timeout: 20_000,
  }, async () => {
    const prefix = raceIdentifier("ifw-dedupe");
    const input: ClaimInput = {
      userId: `${prefix}-user`,
      dedupeKey: `${prefix}-activity`,
      now: new Date("2035-01-01T00:00:00.000Z"),
      windowMs: 60_000,
      maxPerWindow: 5,
    };
    try {
      const results = await runBehindTableBarrier(
        target,
        "ifw_activity_claims",
        () => Promise.all(Array.from({ length: 24 }, () => store.claim(input))),
      );
      assert.deepEqual(counts(results), { claimed: 1, duplicate: 23 });
      const persisted = await target.query(
        "select 1 from ifw_activity_claims where dedupe_key = $1",
        [input.dedupeKey],
      );
      assert.equal(persisted.rowCount, 1);
    } finally {
      await target.query(
        "delete from ifw_activity_claims where dedupe_key like $1",
        [`${prefix}%`],
      );
    }
  });

  await t.test("IFW claims enforce a per-user rate cap under contention", {
    timeout: 20_000,
  }, async () => {
    const prefix = raceIdentifier("ifw-rate");
    const now = new Date("2035-01-02T00:00:00.000Z");
    try {
      const results = await runBehindTableBarrier(
        target,
        "ifw_activity_claims",
        () => Promise.all(Array.from({ length: 24 }, (_, index) => store.claim({
          userId: `${prefix}-user`,
          dedupeKey: `${prefix}-activity-${index}`,
          now,
          windowMs: 60_000,
          maxPerWindow: 5,
        }))),
      );
      assert.deepEqual(counts(results), { claimed: 5, rate_limited: 19 });
      const persisted = await target.query<{ count: number }>(
        "select count(*)::int as count from ifw_activity_claims where user_id = $1",
        [`${prefix}-user`],
      );
      assert.equal(persisted.rows[0]?.count, 5);
    } finally {
      await target.query(
        "delete from ifw_activity_claims where dedupe_key like $1",
        [`${prefix}%`],
      );
    }
  });

  await t.test("IFW expiry boundary reclaims while users remain independent", {
    timeout: 20_000,
  }, async () => {
    const prefix = raceIdentifier("ifw-expiry");
    const boundary = new Date("2035-01-03T00:00:00.000Z");
    const expiringKey = `${prefix}-boundary`;
    try {
      await target.query(
        `insert into ifw_activity_claims
           (dedupe_key, user_id, created_at, expires_at)
         values ($1, $2, $3, $3)`,
        [expiringKey, `${prefix}-old-user`, boundary],
      );
      assert.equal(await store.claim({
        userId: `${prefix}-old-user`,
        dedupeKey: expiringKey,
        now: boundary,
        windowMs: 60_000,
        maxPerWindow: 1,
      }), "claimed");

      const independent = await Promise.all(
        Array.from({ length: 24 }, (_, index) => store.claim({
          userId: `${prefix}-user-${index}`,
          dedupeKey: `${prefix}-independent-${index}`,
          now: boundary,
          windowMs: 60_000,
          maxPerWindow: 1,
        })),
      );
      assert.deepEqual(counts(independent), { claimed: 24 });
      const boundaryRow = await target.query<{ expires_at: Date }>(
        "select expires_at from ifw_activity_claims where dedupe_key = $1",
        [expiringKey],
      );
      assert.equal(
        new Date(boundaryRow.rows[0]!.expires_at).toISOString(),
        "2035-01-03T00:01:00.000Z",
      );
    } finally {
      await target.query(
        "delete from ifw_activity_claims where dedupe_key like $1",
        [`${prefix}%`],
      );
    }
  });

  await t.test("quote creation has one winner and a live row suppresses work", {
    timeout: 20_000,
  }, async () => {
    const prefix = raceIdentifier("quote-new");
    const address = `${prefix}-address`;
    const values = quoteValues(address, "HO3", new Date());
    try {
      const results = await runBehindTableBarrier(
        target,
        "insurance_quote_cache",
        () => Promise.all(
          Array.from({ length: 24 }, () => claimNewQuoteCache(values)),
        ),
      );
      assert.equal(results.filter(rows => rows.length === 1).length, 1);
      assert.equal(results.filter(rows => rows.length === 0).length, 23);
      assert.deepEqual(await claimNewQuoteCache(values), []);
      const read = await readQuoteCache({
        addressNormalized: address,
        policyType: "HO3",
      });
      assert.equal(read.length, 1);
      assert.equal(read[0]?.addressNormalized, address);
    } finally {
      await target.query(
        "delete from insurance_quote_cache where address_normalized like $1",
        [`${prefix}%`],
      );
    }
  });

  for (const staleState of ["expired", "error"] as const) {
    await t.test(`quote ${staleState} row is reclaimed once with a stable id`, {
      timeout: 20_000,
    }, async () => {
      const prefix = raceIdentifier(`quote-${staleState}`);
      const address = `${prefix}-address`;
      const now = new Date();
      const inserted = await target.query<{ id: number }>(
        `insert into insurance_quote_cache
           (address_normalized, address_display, status, policy_type,
            triggered_at, expires_at)
         values ($1, $2, $3, 'HO3', $4, $5)
         returning id`,
        [
          address,
          `${address}.invalid`,
          staleState === "error" ? "error" : "pending",
          new Date(now.getTime() - 120_000),
          staleState === "expired"
            ? new Date(now.getTime() - 1)
            : new Date(now.getTime() + 60_000),
        ],
      );
      const rowId = Number(inserted.rows[0]!.id);
      const replacement = quoteValues(address, "HO3", now);
      try {
        const results = await runBehindTableBarrier(
          target,
          "insurance_quote_cache",
          () => Promise.all(Array.from(
            { length: 24 },
            () => reclaimQuoteCache(rowId, now, replacement),
          )),
        );
        const winners = results.filter(rows => rows.length === 1);
        assert.equal(winners.length, 1);
        assert.equal(results.filter(rows => rows.length === 0).length, 23);
        assert.equal(winners[0]![0]!.id, rowId);
        const persisted = await target.query<{ id: number; count: number }>(
          `select min(id)::bigint as id, count(*)::int as count
             from insurance_quote_cache
            where address_normalized = $1`,
          [address],
        );
        assert.equal(Number(persisted.rows[0]?.id), rowId);
        assert.equal(persisted.rows[0]?.count, 1);
      } finally {
        await target.query(
          "delete from insurance_quote_cache where address_normalized = $1",
          [address],
        );
      }
    });
  }

  await t.test("quote policy identities contend independently", {
    timeout: 20_000,
  }, async () => {
    const prefix = raceIdentifier("quote-policy");
    const address = `${prefix}-address`;
    const now = new Date();
    try {
      const results = await runBehindTableBarrier(
        target,
        "insurance_quote_cache",
        () => Promise.all(
          (["HO3", "HO6"] as const).flatMap(policyType =>
            Array.from(
              { length: 12 },
              () => claimNewQuoteCache(quoteValues(address, policyType, now)),
            )
          ),
        ),
      );
      const winners = results.flat();
      assert.equal(winners.length, 2);
      assert.deepEqual(
        winners.map(row => row.policyType).sort(),
        ["HO3", "HO6"],
      );
      const persisted = await target.query<{ policy_type: string }>(
        `select policy_type
           from insurance_quote_cache
          where address_normalized = $1
          order by policy_type`,
        [address],
      );
      assert.deepEqual(
        persisted.rows.map(row => row.policy_type),
        ["HO3", "HO6"],
      );
    } finally {
      await target.query(
        "delete from insurance_quote_cache where address_normalized = $1",
        [address],
      );
    }
  });
}