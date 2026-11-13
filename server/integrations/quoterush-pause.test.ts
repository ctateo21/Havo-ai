import test from "node:test";
import assert from "node:assert/strict";
import {quoteRushFetch} from "./quoterush-pause";
import {runInsuranceImport} from "./quoterush-import-jobs";
import {pollQuoteJob,resumePendingQuoteJobs} from "./quoterush-background";

test("paused preview never fetches QuoteRush or resumes durable jobs",async()=>{
  const previous=process.env.QUOTERUSH_PAUSED;
  const original=globalThis.fetch;
  let calls=0;
  process.env.QUOTERUSH_PAUSED="true";
  globalThis.fetch=async()=>{calls++;throw Error("No network expected");};
  try{
    assert.throws(()=>quoteRushFetch("https://api.quoterush.com/GetQuotes"),/paused/);
    await runInsuranceImport(1);
    await resumePendingQuoteJobs();
    assert.equal(await pollQuoteJob(1),"pending");
    assert.equal(calls,0);
  }finally{
    globalThis.fetch=original;
    if(previous===undefined)delete process.env.QUOTERUSH_PAUSED;else process.env.QUOTERUSH_PAUSED=previous;
  }
});
