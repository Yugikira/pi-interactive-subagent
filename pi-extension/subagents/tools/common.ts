/** Small helpers shared by the tool registration modules. */
import { muxSetupHint } from "../herdr.ts";

/** First text block of a tool result (content may also hold images). */
export function toolResultText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

export function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require Herdr. ${muxSetupHint()}`,
      },
    ],
    details: { error: "Herdr not available" },
  };
}
