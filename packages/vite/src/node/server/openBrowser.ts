import { Logger } from "../logger";
import colors from "picocolors";
import spawn from "cross-spawn";
import type { ExecOptions } from "node:child_process";
import open, { Options } from "open";
import { join } from "node:path";
import { VITE_PACKAGE_DIR } from "../constants";
import { exec } from "node:child_process";

const supportedChromiumBrowsers = [
  "Google Chrome Canary",
  "Google Chrome Dev",
  "Google Chrome Beta",
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Vivaldi",
  "Chromium",
];

export function openBrowser(
  url: string,
  opt: string | true,
  logger: Logger
): void {
  const browser = typeof opt === "string" ? opt : process.env.BROWSER || "";
  if (browser.toLowerCase().endsWith(".js")) {
    executeNodeScript(browser, url, logger);
  } else if (browser.toLowerCase() !== "none") {
    const browserArgs = process.env.BROWSER_ARGS
      ? process.env.BROWSER_ARGS.split(" ")
      : [];
    startBrowserProcess(browser, browserArgs, url);
  }
}

function executeNodeScript(scriptPath: string, url: string, logger: Logger) {
  const extraArgs = process.argv.slice(2);
  const child = spawn(process.execPath, [scriptPath, ...extraArgs, url], {
    stdio: "inherit",
  });
  child.on("close", (code) => {
    if (code !== 0) {
      logger.error(
        colors.red(
          `\nThe script specified as BROWSER environment variable failed.\n\n${colors.cyan(
            scriptPath
          )} exited with code ${code}.`
        ),
        { error: null }
      );
    }
  });
}

async function startBrowserProcess(
  browser: string | undefined,
  browserArgs: string[],
  url: string
) {
  const preferredOSXBrowser =
    browser === "google chrome" ? "Google Chrome" : browser;
  const shouldTryOpenChromeWithAppleScript =
    process.platform === "darwin" &&
    (!preferredOSXBrowser ||
      supportedChromiumBrowsers.includes(preferredOSXBrowser));

  if (shouldTryOpenChromeWithAppleScript) {
    try {
      const ps = await execAsync("ps cax");
      const openedBrowser =
        preferredOSXBrowser && ps.includes(preferredOSXBrowser)
          ? preferredOSXBrowser
          : supportedChromiumBrowsers.find((b) => ps.includes(b));
      if (openedBrowser) {
        // Try our best to reuse existing tab with AppleScript
        await execAsync(
          `osascript openChrome.applescript "${encodeURI(
            url
          )}" "${openedBrowser}"`,
          {
            cwd: join(VITE_PACKAGE_DIR, "bin"),
          }
        );
        return true;
      }
    } catch (err) {}
  }

  if (process.platform === "darwin" && browser === "open") {
    browser = undefined;
  }

  try {
    const options: Options = browser
      ? { app: { name: browser, arguments: browserArgs } }
      : {};
    open(url, options).catch((e) => {});
    return true;
  } catch (err) {
    return false;
  }
}

function execAsync(command: string, options?: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.toString());
      }
    });
  });
}
