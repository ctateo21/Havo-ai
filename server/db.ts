import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Keep advisory-fence waiters off the main query pool. Otherwise enough
// concurrent writes could occupy every main connection while each waits for
// its actual source mutation to obtain another connection.
export const managedDataFencePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
});
export const db = drizzle({ client: pool, schema });
