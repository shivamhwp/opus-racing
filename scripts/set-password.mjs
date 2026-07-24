#!/usr/bin/env bun
/**
 * Set the site password and put it live.
 *
 * Two things about Cloudflare Pages make doing this by hand error-prone:
 *
 *   1. `wrangler pages secret put` reads the value from stdin. Run it in a
 *      non-interactive shell and it happily uploads an *empty* secret, which
 *      locks the site for everyone including you.
 *   2. Pages binds secrets at deployment time. Changing one has no effect on
 *      the deployment already serving traffic until you redeploy.
 *
 * So this takes the password as an argument, refuses empty ones, uploads it,
 * redeploys, and then proves the new password works and the old one does not.
 *
 *   bun run password 'my-access-key'
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

const PROJECT = "opus-racing";
const ORIGIN = process.env.ORIGIN ?? `https://${PROJECT}.pages.dev`;

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input == null ? "inherit" : "pipe", "inherit", "inherit"] });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

let password = process.argv[2];
if (!password) {
  if (!process.stdin.isTTY) {
    console.error(
      "Usage: bun run password '<access-key>'\n" +
        "Refusing to prompt on a non-interactive stdin — that is exactly how an\n" +
        "empty secret gets uploaded.",
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("New access key: ");
  rl.close();
}

password = password.trim();
if (password.length < 4) {
  console.error("Refusing to set an access key shorter than 4 characters.");
  process.exit(1);
}

console.log(`\n1/3  Uploading the secret to "${PROJECT}"…`);
// No trailing newline: wrangler stores stdin verbatim.
await run("wrangler", ["pages", "secret", "put", "APP_PASSWORD", "--project-name", PROJECT], {
  input: password,
});

console.log("\n2/3  Redeploying — Pages binds secrets at deploy time, so this is required…");
await run("bun", ["run", "build"]);
await run("wrangler", ["pages", "deploy"]);

console.log("\n3/3  Verifying against " + ORIGIN + " …");
const login = (pw) =>
  fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: pw }),
  }).then((r) => r.status);

// Give the new deployment a moment to become the live one.
await new Promise((r) => setTimeout(r, 4000));

const ok = await login(password);
const empty = await login("");
const wrong = await login(password + "-nope");
const gate = await fetch(ORIGIN).then((r) => r.status);

const pass = ok === 200 && empty === 401 && wrong === 401 && gate === 401;
console.log(`     new key      -> ${ok}   ${ok === 200 ? "✓ accepted" : "✗ expected 200"}`);
console.log(`     empty key    -> ${empty}   ${empty === 401 ? "✓ rejected" : "✗ expected 401"}`);
console.log(`     wrong key    -> ${wrong}   ${wrong === 401 ? "✓ rejected" : "✗ expected 401"}`);
console.log(`     gate closed  -> ${gate}   ${gate === 401 ? "✓ app withheld" : "✗ expected 401"}`);
console.log(pass ? "\nLive. The old key no longer works.\n" : "\nSomething is off — see above.\n");
process.exit(pass ? 0 : 1);
