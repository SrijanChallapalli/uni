// Reset and load fictional demo data. Run: npm run seed  (requires DEMO_MODE=true)
import { pool } from "../src/lib/db";
import { resetDemo } from "../src/lib/seed";

if (process.env.DEMO_MODE !== "true") {
  console.error("Refusing to seed: DEMO_MODE is not 'true'. Demo data is only for demo environments.");
  process.exit(1);
}
resetDemo()
  .then((ids) => console.log("Seeded demo personas:", ids))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool().end());
