import "dotenv/config";
import crypto from "crypto";
import path from "path";
import { encryptDataDirectoryAtRest, getLedgerEncryptionPassphrase, inspectDataDirectory } from "./ledgerCrypto.ts";

function parseArgs(argv: string[]) {
  let dir: string | null = null;
  let statusOnly = false;
  let keygen = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--status") statusOnly = true;
    else if (arg === "--keygen") keygen = true;
    else if (arg === "--dir" && argv[i + 1]) {
      dir = argv[++i];
    }
  }

  const defaultDir = path.dirname(path.resolve(process.env.FIAT_LEDGER_PATH || path.join(process.cwd(), "data", "fiat-ledger.json")));
  return { dir: path.resolve(dir || defaultDir), statusOnly, keygen };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.keygen) {
    const key = crypto.randomBytes(32).toString("hex");
    console.log("Add this line to your .env file (keep it secret and back it up safely):");
    console.log(`FIAT_LEDGER_ENCRYPTION_KEY=${key}`);
    return;
  }

  console.log(`Target data directory: ${args.dir}`);
  const inspections = inspectDataDirectory(args.dir);
  for (const item of inspections) {
    console.log(`  - ${path.basename(item.filePath)}: ${item.status}`);
  }

  if (args.statusOnly) return;

  const key = getLedgerEncryptionPassphrase();
  if (!key) {
    console.error("\nERROR: FIAT_LEDGER_ENCRYPTION_KEY is not set in your environment or .env.");
    console.error("Generate a key with:  npm run encrypt-ledger -- --keygen");
    console.error("Then add FIAT_LEDGER_ENCRYPTION_KEY=<key> to .env and re-run:  npm run encrypt-ledger");
    process.exit(1);
  }

  const results = encryptDataDirectoryAtRest(args.dir);
  console.log("\nEncryption-at-rest result:");
  for (const r of results) {
    console.log(`  - ${path.basename(r.filePath)}: ${r.action}`);
  }
}

try {
  main();
} catch (err: any) {
  console.error("Encryption failed:", err?.message || err);
  process.exit(1);
}
