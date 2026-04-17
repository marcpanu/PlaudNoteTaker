/**
 * Markdown post-processor that adds a "Match speakers" button to any note
 * containing the Unknown Speakers callout produced by the PlaudNoteTaker daemon.
 *
 * The callout looks like:
 *
 *   > **Unknown Speakers** — Fill in names and run the command below…
 *   >
 *   > - Speaker A:
 *   > - Speaker B:
 *   >
 *   > ```
 *   > npx tsx src/index.ts label "/path/to/note.md"
 *   > ```
 *
 * On click, the button POSTs the absolute note path to the daemon's
 * /label-speakers bridge endpoint. The daemon runs the same label-and-enroll
 * flow the CLI does (apply speaker names throughout the note, remove the
 * Unknown Speakers callout, enroll new voices in Eagle).
 *
 * The button only appears in Reading View (registerMarkdownPostProcessor).
 * Live Preview support would require a separate CodeMirror editor extension —
 * deferred until there's demand.
 */

import {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Notice,
  Plugin,
  FileSystemAdapter,
} from "obsidian";
import type { BridgeClient } from "./bridge-client";

interface PluginWithBridge extends Plugin {
  bridgeClient: BridgeClient;
}

/** CSS class marker so idempotent renders don't inject twice. */
const BUTTON_CLASS = "plaud-match-speakers-root";

/**
 * MarkdownRenderChild holding the button. Obsidian owns its lifecycle and
 * destroys it on re-render; the idempotence guard prevents double-injection
 * when post-processor fires multiple times during a single render.
 */
class MatchSpeakersButton extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private plugin: PluginWithBridge,
    private notePath: string,
  ) {
    super(containerEl);
  }

  onload(): void {
    // Wrap so we can cleanly remove the whole row on re-render.
    const wrap = this.containerEl.createDiv({ cls: BUTTON_CLASS });
    wrap.style.marginTop = "8px";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "8px";

    const button = wrap.createEl("button", { text: "Match speakers" });
    button.classList.add("mod-cta");
    button.style.cursor = "pointer";

    const status = wrap.createSpan();
    status.style.fontSize = "var(--font-ui-small)";
    status.style.color = "var(--text-muted)";

    const setIdle = (): void => {
      button.disabled = false;
      button.setText("Match speakers");
      status.setText("");
      status.style.color = "var(--text-muted)";
    };

    const setLoading = (): void => {
      button.disabled = true;
      button.setText("Matching…");
      status.setText("");
    };

    const setSuccess = (msg: string): void => {
      button.disabled = false;
      button.setText("Match speakers");
      status.setText(`✓ ${msg}`);
      status.style.color = "var(--text-success)";
    };

    const setError = (msg: string): void => {
      button.disabled = false;
      button.setText("Match speakers");
      status.setText(`✗ ${msg}`);
      status.style.color = "var(--text-error)";
    };

    button.addEventListener("click", async () => {
      setLoading();
      try {
        const result = await this.plugin.bridgeClient.labelSpeakers(this.notePath);
        if (result.ok) {
          setSuccess(`matched ${result.matched}, enrolled ${result.enrolled}`);
          new Notice(
            `Match speakers: matched ${result.matched}, enrolled ${result.enrolled}.`,
          );
        } else {
          setError(result.error ?? "unknown error");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        new Notice(
          msg.includes("Daemon not running")
            ? "PlaudNoteTaker daemon is not running."
            : `Match speakers failed: ${msg}`,
        );
      }
    });

    setIdle();
  }
}

/**
 * Register the post-processor on a plugin instance.
 * Call this from the plugin's onload().
 */
export function registerMatchSpeakersProcessor(plugin: PluginWithBridge): void {
  plugin.registerMarkdownPostProcessor((el, ctx: MarkdownPostProcessorContext) => {
    // Find blockquotes in the just-rendered section. Obsidian calls the
    // post-processor per section (not per full note), so `el` may contain zero
    // or one blockquote. Scan for any descendant with our callout text.
    const blockquotes = el.querySelectorAll("blockquote");
    for (const bq of Array.from(blockquotes)) {
      // Identify our callout by its distinctive "**Unknown Speakers**" text.
      // Using textContent is robust to Obsidian's rendered markup (the bold is
      // a <strong> in the DOM).
      const text = bq.textContent ?? "";
      if (!text.includes("Unknown Speakers")) continue;

      // Idempotence: skip if we've already injected into this blockquote.
      if (bq.querySelector(`.${BUTTON_CLASS}`)) continue;

      // Resolve absolute note path. Bridge endpoint requires an absolute path
      // inside the configured vault; ctx.sourcePath is vault-relative.
      const adapter = plugin.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        // Mobile / non-desktop adapter — bail gracefully.
        continue;
      }
      const absPath = adapter.getFullPath(ctx.sourcePath);

      const child = new MatchSpeakersButton(bq as HTMLElement, plugin, absPath);
      ctx.addChild(child);
    }
  });
}
