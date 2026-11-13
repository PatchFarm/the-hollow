import { ProjectFiles } from "../util/project-files.js";
import { detectCommon } from "./common.js";
import { detectNode } from "./node.js";
import { detectPython } from "./python.js";
import { type Detection, emptyDetection } from "./types.js";

export type { Detection, Finding } from "./types.js";

const PYTHON_MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];

/**
 * Read a project directory and report what it is: language, package manager, frameworks,
 * quality and test tools, database and deploy hints. Read-only, and never reads outside `root`.
 */
export function detectProject(root: string): Detection {
  const files = new ProjectFiles(root);
  const result = emptyDetection(files.root);

  const isNode = files.exists("package.json");
  const pythonMarker = files.firstExisting(PYTHON_MARKERS);

  if (isNode && pythonMarker !== null) {
    result.warnings.push(
      `Found both package.json and ${pythonMarker}. Treating this as a Node project; set project.language in hollow.yml if that is wrong.`,
    );
  }

  if (isNode) {
    result.language = "node";
    detectNode(files, result);
  } else if (pythonMarker !== null) {
    result.language = "python";
    detectPython(files, result);
  } else {
    result.warnings.push(
      "No package.json, pyproject.toml, requirements.txt or setup.py found. The Hollow supports Node/TypeScript and Python projects.",
    );
  }

  detectCommon(files, result);

  if (result.language !== null && result.tests.runners.length === 0) {
    result.warnings.push(
      "No test runner found. The generated pipeline will include a placeholder test step with a TODO, not fake coverage.",
    );
  }
  return result;
}
