const COMMENT_FOOTER = "\n\n---\n[🤖 Otto](https://github.com/scottbenton/otto)";

export function buildComment(
  runId: string,
  machineId: string,
  sourceKey: string,
  content: string,
): string {
  return `<!-- otto:v1 status run=${runId} machine=${machineId} source=${sourceKey} -->\n${content}${COMMENT_FOOTER}`;
}
