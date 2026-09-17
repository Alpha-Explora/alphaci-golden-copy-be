#!/usr/bin/env node
'use strict';
/**
 * Run a command with one edition's composition variables set.
 *
 *   node scripts/run-edition.mjs <edition> <command> [args...]
 *
 * The profile is derived here rather than passed in, because the pairing is not
 * free: saas and edu both compile from the hosted profile and enterprise has its
 * own. Setting the two by hand is how a deployment ends up running an edition its
 * artifact never compiled.
 *
 * Values set here win over .env files. dotenv and Next both leave an existing
 * process.env entry alone rather than overwriting it.
 *
 * Each mode clears ALPHACI_CLIENT and ALPHACI_CLIENT_CONFIG unless it wants them,
 * so a client left in .env cannot leak into a run that is not testing one.
 * enterprise-client uses northwind, the only policy declared in src/packs.
 */
import { spawn } from "node:child_process";

const EDITIONS = {
  saas: {
    ALPHACI_BUILD_PROFILE: "hosted",
    ALPHACI_EDITION: "saas",
    ALPHACI_CLIENT: "",
    ALPHACI_CLIENT_CONFIG: "",
  },
  edu: {
    ALPHACI_BUILD_PROFILE: "hosted",
    ALPHACI_EDITION: "edu",
    ALPHACI_CLIENT: "",
    ALPHACI_CLIENT_CONFIG: "",
  },
  enterprise: {
    ALPHACI_BUILD_PROFILE: "enterprise",
    ALPHACI_EDITION: "enterprise",
    ALPHACI_CLIENT: "",
    ALPHACI_CLIENT_CONFIG: "",
  },
  "enterprise-client": {
    ALPHACI_BUILD_PROFILE: "enterprise",
    ALPHACI_EDITION: "enterprise",
    ALPHACI_CLIENT: "northwind",
    ALPHACI_CLIENT_CONFIG: "",
  },
};

const [edition, ...command] = process.argv.slice(2);

if (edition === undefined || !Object.hasOwn(EDITIONS, edition)) {
  console.error(
    "Unknown edition " +
      JSON.stringify(edition ?? "") +
      ". Expected one of: " +
      Object.keys(EDITIONS).join(", ") +
      ".",
  );
  process.exit(2);
}

if (command.length === 0) {
  console.error(
    "No command given. Usage: node scripts/run-edition.mjs <edition> <command> [args...]",
  );
  process.exit(2);
}

const composition = EDITIONS[edition];
const shown = Object.entries(composition)
  .map(([key, value]) => key + "=" + (value === "" ? "<unset>" : value))
  .join(" ");
console.log("[run-edition] " + edition + ": " + shown);

// The command is joined rather than passed as argv. Node deprecates argv plus
// shell:true (DEP0190) because the arguments are concatenated without escaping.
// Concatenating here is safe and equivalent: every command comes from a package
// script in this repository, never from user input.
const child = spawn(command.join(" "), {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ...composition },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
