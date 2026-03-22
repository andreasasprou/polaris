/**
 * Remark plugin that transforms file path references in text into
 * custom `fileRef` MDAST nodes, which render as inline pill components.
 *
 * Uses `mdast-util-find-and-replace` to operate at the AST level,
 * skipping code blocks, inline code, and links.
 */
import { findAndReplace } from "mdast-util-find-and-replace";
import type { PhrasingContent, Root } from "mdast";
import { FILE_PATH_REGEX, parseFilePath } from "./file-path-pattern";

export default function remarkFileRefs() {
  return (tree: Root) => {
    findAndReplace(
      tree,
      [
        [
          FILE_PATH_REGEX,
          (_match: string) => {
            const { path, line, lineEnd } = parseFilePath(_match);
            const fileName = path.split("/").pop() ?? path;

            let displayName = fileName;
            if (line != null) {
              displayName += `:${line}`;
              if (lineEnd != null) {
                displayName += `-${lineEnd}`;
              }
            }

            // Return a custom MDAST node that remark-rehype maps to <file-ref>
            // via data.hName / data.hProperties. Cast needed because "fileRef"
            // is not a built-in PhrasingContent type.
            return {
              type: "fileRef",
              data: {
                hName: "file-ref",
                hProperties: {
                  path,
                  fileName,
                  ...(line != null ? { line: String(line) } : {}),
                  ...(lineEnd != null ? { lineEnd: String(lineEnd) } : {}),
                },
              },
              children: [{ type: "text", value: displayName }],
            } as unknown as PhrasingContent;
          },
        ],
      ],
      { ignore: ["link", "linkReference", "code", "inlineCode"] },
    );
  };
}
