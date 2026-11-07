/**
 * Generates a hash for APP_PASSWORD_HASH.
 *
 *   npm run hash-password
 *
 * Prompts for the password without echoing it, then prints the hash. Paste the
 * hash into .env.local and into Vercel's environment variables. The hash is
 * safe to store; the password itself should live only in your head or your
 * password manager.
 */
import { hashPassword } from "../lib/auth/password";

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;

    if (!stdin.isTTY) {
      reject(new Error("Run this command in an interactive terminal."));
      return;
    }

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let typed = "";

    function onData(chunk: string): void {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(typed);
          return;
        }
        if (character === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (character === "\u007f" || character === "\b") {
          typed = typed.slice(0, -1);
          continue;
        }
        typed += character;
      }
    }

    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const password = await promptHidden("New password (min 10 characters): ");
  if (password.length < 10) {
    throw new Error("Please use at least 10 characters.");
  }

  const confirmation = await promptHidden("Repeat password: ");
  if (confirmation !== password) {
    throw new Error("The two passwords did not match.");
  }

  const hash = await hashPassword(password);
  console.log("\nAdd this line to .env.local and to your Vercel environment variables:\n");
  console.log(`APP_PASSWORD_HASH=${hash}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

