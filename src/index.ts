#!/usr/bin/env node

import { runInit } from "./cli/init.js";
import { runStart } from "./cli/start.js";
import { runLabel } from "./cli/label.js";
import { runSpeakersList, runSpeakersDelete } from "./cli/speakers.js";

const [command, ...args] = process.argv.slice(2);

const USAGE = `Usage: plaude <command> [args]

Commands:
  init                  Set up API keys and configuration
  start                 Start polling for new recordings
  label <note-file>     Apply speaker labels from a note file
  speakers list         List enrolled speaker profiles
  speakers delete <name> Delete a speaker profile
`;

async function main(): Promise<void> {
  switch (command) {
    case "init":
      await runInit();
      break;

    case "start":
      await runStart();
      break;

    case "label": {
      const noteFile = args[0];
      if (!noteFile) {
        console.error("Usage: plaude label <note-file>");
        process.exit(1);
      }
      await runLabel(noteFile);
      break;
    }

    case "speakers":
      switch (args[0]) {
        case "list":
          runSpeakersList();
          break;
        case "delete": {
          const name = args.slice(1).join(" ");
          if (!name) {
            console.error("Usage: plaude speakers delete <name>");
            process.exit(1);
          }
          runSpeakersDelete(name);
          break;
        }
        default:
          console.error("Usage: plaude speakers <list|delete <name>>");
          process.exit(1);
      }
      break;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
