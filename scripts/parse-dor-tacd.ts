/** Offline only: emits reviewable seed JSON, never applies it to a database.
 * Usage: npx tsx scripts/parse-dor-tacd.ts file.pdf source-url output.json */
import {readFile,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
const pdf:typeof import("pdf-parse")=createRequire(import.meta.url)("pdf-parse");
import {parsePinellasTacd} from "../server/integrations/dor-tacd";
const [file,url,out]=process.argv.slice(2);
if(!file||!url||!out||!url.startsWith("https://floridarevenue.com/"))throw Error("Provide local PDF, official DOR source URL and output JSON");
const document=await pdf(await readFile(file));
const rows=parsePinellasTacd(document.text,url,new Date().toISOString());
await writeFile(out,JSON.stringify(rows,null,2));
console.log(`Prepared ${rows.length} prior-year seed rows for review; no database writes.`);
