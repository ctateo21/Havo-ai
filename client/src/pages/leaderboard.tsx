/**
 * leaderboard.tsx — v10
 * Changes from v9:
 *   1. RE table: added "RE Commission" column alongside RE Total Vol.
 *   2. MTG table: "Closed Commission" now shows only mortgage2026 commission
 *      (closed deals only, not Under Contract).
 *   3. Deal Pipeline section: always shows Full Year badge, no period label.
 *   4. Activity period tabs clearly labelled as affecting Activity only.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/auth-context";
import { authedFetch } from "@/lib/authed-fetch";

type Period = "today" | "yesterday" | "week" | "month" | "quarter" | "year";

interface DealBucket {
  count:      number;
  volume:     number;
  commission: number;
}

interface AgentDeals {
  reActiveListing:       DealBucket;
  reUnderContractBuy:    DealBucket;
  reUnderContractSell:   DealBucket;
  re2026Buy:             DealBucket;
  re2026Sell:            DealBucket;
  mortgageUnderContract: DealBucket;
  mortgage2026:          DealBucket;
  totalVolume:     number;
  totalCommission: number;
  totalCount:      number;
}

interface AgentRow {
  email: string;
  name: string;
  initials: string;
  isAdmin: boolean;
  calls: number;
  texts: number;
  emails: number;
  showings: number;
  showingDays: number;
  closedDeals: number;
  underContract: number;
  pipeline: Record<string, number>;
  totalActivity: number;
  totalLeads: number;
  newLeads: number;
  deals: AgentDeals;
}

interface LeaderboardData {
  period: string;
  generatedAt: string;
  refreshState?: "fresh" | "cached" | "partial";
  retryAfterSeconds?: number;
  collectionWarnings?: string[];
  agents: AgentRow[];
  teamTotals: {
    calls: number;
    texts: number;
    emails: number;
    showings: number;
    showingDays: number;
    closedDeals: number;
    underContract: number;
    totalActivity: number;
    totalLeads: number;
    newLeads: number;
    dealVolume: number;
    dealCommission: number;
    dealCount: number;
  };
}

const TEAM_EMAILS = new Set([
  "christian@tateoco.com",
  "omar@tateoco.com",
  "kyle@tateoco.com",
  "alex@tateoco.com",
  "courtney@tateoco.com",
]);

const PERIOD_LABELS: Record<Period, string> = {
  today:     "Today",
  yesterday: "Yesterday",
  week:      "Last 7 Days",
  month:     "Last 30 Days",
  quarter:   "This Quarter",
  year:      "This Year",
};

const HIGHLIGHT_STAGES = [
  "Lead", "Attempted Contact", "Appointment Set",
  "Showing Homes", "Submitting Offers", "Under Contract", "Closed",
];

const AUTO_REFRESH_MS = 5 * 60 * 1000;
const CURRENT_YEAR = new Date().getFullYear();

function fmt$(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return "$" + (n / 1_000).toFixed(0) + "K";
  return "$" + n.toLocaleString();
}

function StatBadge({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      <span className="text-xs text-gray-400 uppercase tracking-wide">{label}</span>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-2xl">🥇</span>;
  if (rank === 2) return <span className="text-2xl">🥈</span>;
  if (rank === 3) return <span className="text-2xl">🥉</span>;
  return (
    <span className="h-8 w-8 rounded-full bg-gray-700 text-gray-300 text-sm font-bold flex items-center justify-center">
      {rank}
    </span>
  );
}

function PipelineBar({ pipeline }: { pipeline: Record<string, number> }) {
  return (
    <div className="text-xs space-y-0.5">
      {HIGHLIGHT_STAGES.map((stage) => {
        const count = pipeline[stage] ?? 0;
        if (count === 0) return null;
        return (
          <div key={stage} className="flex items-center gap-1.5">
            <span className="text-gray-400 w-28 truncate">{stage}</span>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-teal-900/50 text-teal-300">
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BucketCell({ bucket, dimCommission }: { bucket: DealBucket; dimCommission?: boolean }) {
  if (bucket.count === 0) return <span className="text-gray-600 text-sm">—</span>;
  return (
    <div className="text-xs space-y-0.5">
      <div className="font-bold text-white">{bucket.count} deal{bucket.count !== 1 ? "s" : ""}</div>
      <div className="text-teal-400">{fmt$(bucket.volume)}</div>
      {bucket.commission > 0 && (
        <div className={dimCommission ? "text-gray-500" : "text-green-400"}>
          {fmt$(bucket.commission)} comm
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, rank }: { agent: AgentRow; rank: number }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 space-y-3">
      <div className="flex items-center gap-3">
        <RankBadge rank={rank} />
        <div className="h-10 w-10 rounded-full bg-[#0D9488] flex items-center justify-center font-bold text-white text-sm shrink-0">
          {agent.initials}
        </div>
        <div>
          <p className="font-semibold text-white">{agent.name}</p>
          <p className="text-xs text-gray-400">{agent.email}</p>
        </div>
        {agent.closedDeals > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-900/60 text-green-300 text-xs font-semibold">
            🏆 {agent.closedDeals} Closed
          </span>
        )}
      </div>
      <div className="grid grid-cols-5 gap-2 pt-1">
        <StatBadge value={agent.calls}    label="Calls"    color="text-blue-400" />
        <StatBadge value={agent.texts}    label="Texts"    color="text-purple-400" />
        <StatBadge value={agent.emails}   label="Emails"   color="text-orange-400" />
        <StatBadge value={agent.showings} label="Homes" color="text-teal-400" />
        <StatBadge value={agent.showingDays} label="Show Days" color="text-cyan-400" />
      </div>
      <div className="flex flex-wrap gap-3">
        {agent.underContract > 0 && (
          <p className="text-xs text-yellow-400 font-medium">🔑 {agent.underContract} Under Contract</p>
        )}
        {agent.newLeads > 0 && (
          <p className="text-xs text-emerald-400 font-medium">
            🌱 {agent.newLeads} New {agent.newLeads === 1 ? "Lead" : "Leads"}
          </p>
        )}
      </div>
      {agent.deals.totalCount > 0 && (
        <div className="border-t border-gray-700 pt-2 text-xs space-y-1">
          <p className="text-gray-500 uppercase tracking-wide font-medium">Deal Pipeline {CURRENT_YEAR}</p>
          <p className="text-white font-semibold">
            {agent.deals.totalCount} deals · {fmt$(agent.deals.totalVolume)} vol · {fmt$(agent.deals.totalCommission)} comm
          </p>
        </div>
      )}
      <div className="border-t border-gray-700 pt-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Pipeline</p>
        <PipelineBar pipeline={agent.pipeline} />
      </div>
    </div>
  );
}

function AgentTableRow({ agent, rank }: { agent: AgentRow; rank: number }) {
  return (
    <tr className="border-b border-gray-700 hover:bg-gray-800/60 transition-colors">
      <td className="px-4 py-4 text-center"><RankBadge rank={rank} /></td>
      <td className="px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-[#0D9488] flex items-center justify-center font-bold text-white text-sm shrink-0">
            {agent.initials}
          </div>
          <div>
            <p className="font-semibold text-white text-sm">{agent.name}</p>
            <p className="text-xs text-gray-400">{agent.email}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-blue-400">{agent.calls}</span></td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-purple-400">{agent.texts}</span></td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-orange-400">{agent.emails}</span></td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-teal-400">{agent.showings}</span></td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-cyan-400">{agent.showingDays}</span></td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-yellow-400">{agent.underContract}</span></td>
      <td className="px-4 py-4 text-center">
        {agent.closedDeals > 0 ? (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-900/60 text-green-300 text-sm font-bold">
            🏆 {agent.closedDeals}
          </span>
        ) : <span className="text-gray-600">—</span>}
      </td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-white">{agent.totalActivity}</span></td>
      <td className="px-4 py-4 text-center"><span className="text-lg font-bold text-emerald-400">{agent.newLeads}</span></td>
      <td className="px-4 py-4"><PipelineBar pipeline={agent.pipeline} /></td>
    </tr>
  );
}

function sumBuckets(agents: AgentRow[], getter: (a: AgentRow) => DealBucket): DealBucket {
  return agents.reduce(
    (acc, a) => {
      const b = getter(a);
      return { count: acc.count + b.count, volume: acc.volume + b.volume, commission: acc.commission + b.commission };
    },
    { count: 0, volume: 0, commission: 0 },
  );
}

function DealPipelineSection({ agents }: { agents: AgentRow[] }) {
  // Pre-compute team totals
  const reActiveListing    = sumBuckets(agents, a => a.deals.reActiveListing);
  const reUnderContractBuy = sumBuckets(agents, a => a.deals.reUnderContractBuy);
  const reUnderContractSell= sumBuckets(agents, a => a.deals.reUnderContractSell);
  const re2026Buy          = sumBuckets(agents, a => a.deals.re2026Buy);
  const re2026Sell         = sumBuckets(agents, a => a.deals.re2026Sell);
  const reTeamVol  = reActiveListing.volume + reUnderContractBuy.volume + reUnderContractSell.volume + re2026Buy.volume + re2026Sell.volume;
  const reTeamComm = reActiveListing.commission + reUnderContractBuy.commission + reUnderContractSell.commission + re2026Buy.commission + re2026Sell.commission;

  const mtgUnderContract = sumBuckets(agents, a => a.deals.mortgageUnderContract);
  const mtg2026          = sumBuckets(agents, a => a.deals.mortgage2026);
  const mtgTeamVol  = mtgUnderContract.volume + mtg2026.volume;
  const mtgTeamComm = mtg2026.commission; // closed only

  const sortedAgents = [...agents].sort((a, b) => {
    const lastA = a.name.split(" ").pop() ?? a.name;
    const lastB = b.name.split(" ").pop() ?? b.name;
    return lastA.localeCompare(lastB);
  });

  const hasAnyRE  = agents.some(a =>
    a.deals.reActiveListing.count + a.deals.reUnderContractBuy.count +
    a.deals.reUnderContractSell.count + a.deals.re2026Buy.count + a.deals.re2026Sell.count > 0
  );
  const hasAnyMtg = agents.some(a =>
    a.deals.mortgageUnderContract.count + a.deals.mortgage2026.count > 0
  );

  if (!hasAnyRE && !hasAnyMtg) {
    return (
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 text-center">
        <p className="text-gray-500 text-sm">No deals found for {CURRENT_YEAR}.</p>
        <p className="text-gray-600 text-xs mt-1">Active pipeline always shows. Closed deals are filtered by projected close date within the current year.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Real Estate */}
      {hasAnyRE && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
          <div className="bg-gray-900/60 px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-teal-400 uppercase tracking-wide">🏠 Real Estate</h3>
            <span className="text-xs text-gray-500">Active + Under Contract = current pipeline · 2026 = closed this year</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-xs text-gray-400 uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">Agent</th>
                  <th className="px-4 py-3 text-center">Active Listing</th>
                  <th className="px-4 py-3 text-center">UC – Buy</th>
                  <th className="px-4 py-3 text-center">UC – Sell</th>
                  <th className="px-4 py-3 text-center">2026 – Buy</th>
                  <th className="px-4 py-3 text-center">2026 – Sell</th>
                  <th className="px-4 py-3 text-center text-white">RE Total Vol</th>
                  <th className="px-4 py-3 text-center text-green-400">RE Commission</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b-2 border-gray-600 bg-gray-900/60">
                  <td className="px-4 py-3">
                    <span className="text-white font-bold text-sm uppercase tracking-wide">Team Total</span>
                  </td>
                  <td className="px-4 py-3 text-center"><BucketCell bucket={reActiveListing} dimCommission /></td>
                  <td className="px-4 py-3 text-center"><BucketCell bucket={reUnderContractBuy} /></td>
                  <td className="px-4 py-3 text-center"><BucketCell bucket={reUnderContractSell} /></td>
                  <td className="px-4 py-3 text-center"><BucketCell bucket={re2026Buy} /></td>
                  <td className="px-4 py-3 text-center"><BucketCell bucket={re2026Sell} /></td>
                  <td className="px-4 py-3 text-center"><span className="font-bold text-teal-300 text-sm">{fmt$(reTeamVol)}</span></td>
                  <td className="px-4 py-3 text-center"><span className="font-bold text-green-300 text-sm">{fmt$(reTeamComm)}</span></td>
                </tr>
                {sortedAgents.map((agent) => {
                  const d = agent.deals;
                  const reVol  = d.reActiveListing.volume     + d.reUnderContractBuy.volume  +
                                 d.reUnderContractSell.volume + d.re2026Buy.volume            + d.re2026Sell.volume;
                  const reComm = d.reActiveListing.commission + d.reUnderContractBuy.commission +
                                 d.reUnderContractSell.commission + d.re2026Buy.commission    + d.re2026Sell.commission;
                  return (
                    <tr key={agent.email} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-[#0D9488] flex items-center justify-center text-white text-xs font-bold shrink-0">
                            {agent.initials}
                          </div>
                          <span className="text-white font-medium text-sm">{agent.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center"><BucketCell bucket={d.reActiveListing} dimCommission /></td>
                      <td className="px-4 py-3 text-center"><BucketCell bucket={d.reUnderContractBuy} /></td>
                      <td className="px-4 py-3 text-center"><BucketCell bucket={d.reUnderContractSell} /></td>
                      <td className="px-4 py-3 text-center"><BucketCell bucket={d.re2026Buy} /></td>
                      <td className="px-4 py-3 text-center"><BucketCell bucket={d.re2026Sell} /></td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-bold text-white">{fmt$(reVol)}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-bold text-green-400">{fmt$(reComm)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mortgage */}
      {hasAnyMtg && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
          <div className="bg-gray-900/60 px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wide">💰 Mortgage</h3>
            <span className="text-xs text-gray-500">Under Contract = current pipeline · 2026 = closed this year · Commission = closed only</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-xs text-gray-400 uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">Agent</th>
                  <th className="px-4 py-3 text-center">Under Contract</th>
                  <th className="px-4 py-3 text-center">2026 (Closed)</th>
                  <th className="px-4 py-3 text-center text-white">Mtg Total Vol</th>
                  <th className="px-4 py-3 text-center text-green-400">Closed Commission</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b-2 border-gray-600 bg-gray-900/60">
                  <td className="px-4 py-3">
                    <span className="text-white font-bold text-sm uppercase tracking-wide">Team Total</span>
                  </td>
                  <td className="px-4 py-3 text-center"><BucketCell bucket={mtgUnderContract} /></td>
                  <td className="px-4 py-3 text-center"><BucketCell bucket={mtg2026} /></td>
                  <td className="px-4 py-3 text-center"><span className="font-bold text-teal-300 text-sm">{fmt$(mtgTeamVol)}</span></td>
                  <td className="px-4 py-3 text-center"><span className="font-bold text-green-300 text-sm">{fmt$(mtgTeamComm)}</span></td>
                </tr>
                {sortedAgents.map((agent) => {
                  const d       = agent.deals;
                  const mtgVol  = d.mortgageUnderContract.volume + d.mortgage2026.volume;
                  const mtgComm = d.mortgage2026.commission; // closed deals only
                  return (
                    <tr key={agent.email} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-[#0D9488] flex items-center justify-center text-white text-xs font-bold shrink-0">
                            {agent.initials}
                          </div>
                          <span className="text-white font-medium text-sm">{agent.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center"><BucketCell bucket={d.mortgageUnderContract} /></td>
                      <td className="px-4 py-3 text-center"><BucketCell bucket={d.mortgage2026} /></td>
                      <td className="px-4 py-3 text-center">
                        <span className="font-bold text-white">{fmt$(mtgVol)}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                          <span className="font-bold text-green-400">{fmt$(mtgComm)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Leaderboard() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [period, setPeriod] = useState<Period>("today");
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!authLoading && (!user || !TEAM_EMAILS.has((user.email ?? "").toLowerCase()))) {
      setLocation("/dashboard");
    }
  }, [user, authLoading, setLocation]);

  const fetchData = useCallback(async (p: Period, silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/fub/leaderboard?period=${p}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error || `Server error ${res.status}`);
      }
      const json: LeaderboardData = await res.json();
      const emptyBucket = { count: 0, volume: 0, commission: 0 };
      const emptyDeals: AgentDeals = {
        reActiveListing: emptyBucket, reUnderContractBuy: emptyBucket, reUnderContractSell: emptyBucket,
        re2026Buy: emptyBucket, re2026Sell: emptyBucket,
        mortgageUnderContract: emptyBucket, mortgage2026: emptyBucket,
        totalVolume: 0, totalCommission: 0, totalCount: 0,
      };
      json.agents = (json.agents ?? []).map((a) => ({ ...a, deals: a.deals ?? emptyDeals }));
      json.teamTotals = {
        ...json.teamTotals,
        dealVolume:     json.teamTotals?.dealVolume     ?? 0,
        dealCommission: json.teamTotals?.dealCommission ?? 0,
        dealCount:      json.teamTotals?.dealCount      ?? 0,
      };
      setData(json);
      setLastRefresh(new Date(json.generatedAt));
    } catch (err: any) {
      setError(err.message ?? "Failed to load leaderboard data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user && TEAM_EMAILS.has((user.email ?? "").toLowerCase())) fetchData(period);
  }, [period, user, fetchData]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (user && TEAM_EMAILS.has((user.email ?? "").toLowerCase())) fetchData(period, true);
    }, AUTO_REFRESH_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [period, user, fetchData]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-teal-400" />
      </div>
    );
  }

  if (!user || !TEAM_EMAILS.has((user.email ?? "").toLowerCase())) return null;

  const totals = data?.teamTotals;
  const activityAgents = [...(data?.agents ?? [])].sort((a, b) => {
    const lastA = a.name.split(" ").pop() ?? a.name;
    const lastB = b.name.split(" ").pop() ?? b.name;
    return lastA.localeCompare(lastB);
  });

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <div className="bg-[#0F172A] border-b border-gray-800 px-4 py-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-white">Team Leaderboard</h1>
              <p className="text-sm text-gray-400 mt-0.5">
                Live activity from FollowUpBoss · Auto-refreshes every 5 min
                {lastRefresh && (
                  <span className="ml-2 text-gray-500">
                    · Updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={() => fetchData(period)}
              disabled={loading}
              className="self-start sm:self-auto flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors disabled:opacity-50"
            >
              <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582M20 20v-5h-.581M4.582 9A8 8 0 0120 15M19.418 15A8 8 0 014 9" />
              </svg>
              Refresh
            </button>
          </div>
          {data?.refreshState === "cached" && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              Showing the last cached leaderboard while Follow Up Boss refreshes
              {data.retryAfterSeconds ? ` after a ${data.retryAfterSeconds}-second rate-limit pause` : ""}.
            </div>
          )}
          {data?.refreshState === "partial" && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              Some Follow Up Boss activity could not be refreshed. Available leaderboard data is shown
              {data.retryAfterSeconds ? `; retrying in about ${data.retryAfterSeconds} seconds` : ""}.
            </div>
          )}
          {/* Period tabs — affects Activity section only */}
          <div className="mt-5">
            <p className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Activity Period</p>
            <div className="flex gap-1 overflow-x-auto">
              {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    period === p
                      ? "bg-[#0D9488] text-white"
                      : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-8">
        {/* Activity totals strip */}
        {totals && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-3">
            {[
              { label: "📞 Calls",     value: totals.calls,         color: "text-blue-400" },
              { label: "💬 Texts",     value: totals.texts,         color: "text-purple-400" },
              { label: "📧 Emails",    value: totals.emails,        color: "text-orange-400" },
              { label: "🏠 Homes Shown", value: totals.showings,    color: "text-teal-400" },
              { label: "📅 Showing Days", value: totals.showingDays, color: "text-cyan-400" },
              { label: "🔑 Contract",  value: totals.underContract, color: "text-yellow-400" },
              { label: "🏆 Closed",    value: totals.closedDeals,   color: "text-green-400" },
              { label: "⚡ Total",      value: totals.totalActivity, color: "text-white" },
              { label: "🌱 New Leads", value: totals.newLeads,      color: "text-emerald-400" },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-800 rounded-xl p-3 text-center border border-gray-700">
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                <p className="text-xs text-gray-400 mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Deal totals strip — total row + RE/Mortgage split below */}
        {totals && totals.dealCount > 0 && data && (() => {
          const reCount = data.agents.reduce((s, a) => s + a.deals.reActiveListing.count + a.deals.reUnderContractBuy.count + a.deals.reUnderContractSell.count + a.deals.re2026Buy.count + a.deals.re2026Sell.count, 0);
          const reVol = data.agents.reduce((s, a) => s + a.deals.reActiveListing.volume + a.deals.reUnderContractBuy.volume + a.deals.reUnderContractSell.volume + a.deals.re2026Buy.volume + a.deals.re2026Sell.volume, 0);
          const reComm = data.agents.reduce((s, a) => s + a.deals.reActiveListing.commission + a.deals.reUnderContractBuy.commission + a.deals.reUnderContractSell.commission + a.deals.re2026Buy.commission + a.deals.re2026Sell.commission, 0);
          const mtgCount = data.agents.reduce((s, a) => s + a.deals.mortgageUnderContract.count + a.deals.mortgage2026.count, 0);
          const mtgVol = data.agents.reduce((s, a) => s + a.deals.mortgageUnderContract.volume + a.deals.mortgage2026.volume, 0);
          const mtgComm = data.agents.reduce((s, a) => s + a.deals.mortgage2026.commission, 0);

          return (
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: `📋 ${CURRENT_YEAR} Deals`, value: totals.dealCount, color: "text-white", re: reCount, mtg: mtgCount, reColor: "text-teal-400", mtgColor: "text-blue-400" },
                { label: `💵 ${CURRENT_YEAR} Volume`, value: fmt$(totals.dealVolume), color: "text-teal-400", re: fmt$(reVol), mtg: fmt$(mtgVol), reColor: "text-teal-400", mtgColor: "text-blue-400" },
                { label: `💰 ${CURRENT_YEAR} Commission`, value: fmt$(totals.dealCommission), color: "text-green-400", re: fmt$(reComm), mtg: fmt$(mtgComm), reColor: "text-green-400", mtgColor: "text-green-400" },
              ].map(({ label, value, color, re, mtg, reColor, mtgColor }) => (
                <div key={label} className="space-y-2">
                  <div className="bg-gray-800 rounded-xl p-3 text-center border border-gray-700">
                    <p className={`text-2xl font-bold ${color}`}>{value}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{label}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-800/60 rounded-xl p-2 text-center border border-gray-700">
                      <p className={`text-lg font-bold ${reColor}`}>{re}</p>
                      <p className="text-xs text-gray-500">🏠 Real Estate</p>
                    </div>
                    <div className="bg-gray-800/60 rounded-xl p-2 text-center border border-gray-700">
                      <p className={`text-lg font-bold ${mtgColor}`}>{mtg}</p>
                      <p className="text-xs text-gray-500">💰 Mortgage</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">
            <strong>Error loading leaderboard:</strong> {error}
          </div>
        )}

        {loading && !data && (
          <div className="space-y-3">
            {[1,2,3,4].map((i) => (
              <div key={i} className="bg-gray-800 rounded-xl h-24 animate-pulse border border-gray-700" />
            ))}
          </div>
        )}

        {/* Activity section */}
        {data && (
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-2">
              Activity
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-700 text-gray-300 normal-case">
                {PERIOD_LABELS[period]}
              </span>
            </h2>
            <div className="hidden md:block">
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-900/60 border-b border-gray-700">
                      <th className="px-4 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wide w-12">#</th>
                      <th className="px-4 py-3 text-left   text-xs font-semibold text-gray-400   uppercase tracking-wide">Agent</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-blue-400   uppercase tracking-wide">📞 Calls</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-purple-400 uppercase tracking-wide">💬 Texts</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-orange-400 uppercase tracking-wide">📧 Emails</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-teal-400   uppercase tracking-wide">🏠 Homes</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-cyan-400   uppercase tracking-wide">📅 Days</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-yellow-400 uppercase tracking-wide">🔑 Contract</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-green-400  uppercase tracking-wide">🏆 Closed</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-white      uppercase tracking-wide">⚡ Total</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-emerald-400 uppercase tracking-wide">🌱 New Leads</th>
                      <th className="px-4 py-3 text-left   text-xs font-semibold text-gray-400   uppercase tracking-wide">Pipeline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityAgents.map((agent, i) => (
                      <AgentTableRow key={agent.email} agent={agent} rank={i + 1} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="md:hidden space-y-3">
              {activityAgents.map((agent, i) => (
                <AgentCard key={agent.email} agent={agent} rank={i + 1} />
              ))}
            </div>
          </div>
        )}

        {/* Deal Pipeline — always full year, independent of activity period */}
        {data && (
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-2">
              Deal Pipeline
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal-900/50 text-teal-300 normal-case">
                Full Year {CURRENT_YEAR}
              </span>
            </h2>
            <DealPipelineSection agents={data.agents} />
          </div>
        )}

        {data && (
          <p className="text-center text-xs text-gray-600">
            Activity: <strong className="text-gray-500">{PERIOD_LABELS[period]}</strong>
            {" · "}Deal Pipeline: full year {CURRENT_YEAR} · active stages always shown · closed filtered by projected close date
            {" · "}Generated {new Date(data.generatedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}