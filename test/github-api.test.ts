import { chmodSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentRepo,
  errorMessage,
  GitHubError,
  ghApi,
  isRepoName,
  parseIncluded,
} from "../src/github/api.js";
import { tempProject } from "./helpers.js";

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

/** Put a stand-in `gh` first on PATH. It answers like `gh api --include` and echoes what it got. */
function fakeGh(script: string): string {
  const dir = tempProject({ gh: `#!/bin/sh\n${script}\n` });
  chmodSync(path.join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  return dir;
}

describe("parseIncluded", () => {
  it("reads the status and JSON body", () => {
    expect(parseIncluded('HTTP/2.0 201 Created\r\nX-A: 1\r\n\r\n{"id":5}')).toEqual({
      status: 201,
      data: { id: 5 },
    });
    expect(parseIncluded("HTTP/2.0 204 No Content\nX-A: 1\n\n")).toEqual({
      status: 204,
      data: null,
    });
    expect(parseIncluded("HTTP/1.1 502 Bad Gateway\n\n<html>")).toEqual({
      status: 502,
      data: "<html>",
    });
  });

  it("returns null when GitHub never answered", () => {
    expect(parseIncluded("")).toBeNull();
    expect(parseIncluded("error connecting to api.github.com")).toBeNull();
  });
});

describe("errorMessage", () => {
  it("joins GitHub's message and field errors", () => {
    expect(
      errorMessage({
        status: 422,
        data: { message: "Validation Failed", errors: [{ message: "bad reviewer" }, "too many"] },
      }),
    ).toBe("Validation Failed: bad reviewer: too many (HTTP 422)");
    expect(errorMessage({ status: 500, data: null })).toBe("HTTP 500");
  });
});

describe("ghApi", () => {
  it("calls gh api with the method, headers and path, and sends the body on stdin", async () => {
    fakeGh(`input=$(cat)
printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'
printf '{"args":"%s","input":%s}' "$*" "\${input:-null}"`);
    const response = await ghApi(process.cwd()).request("PUT", "repos/o/r/environments/staging", {
      a: 1,
    });
    expect(response.status).toBe(200);
    const data = response.data as { args: string; input: unknown };
    expect(data.args).toBe(
      "api --include --method PUT -H Accept: application/vnd.github+json -H X-GitHub-Api-Version: 2022-11-28 repos/o/r/environments/staging --input -",
    );
    expect(data.input).toEqual({ a: 1 });
  });

  it("returns HTTP errors as responses, not exceptions", async () => {
    fakeGh(`printf 'HTTP/2.0 404 Not Found\\n\\n{"message":"Not Found"}'
echo "gh: Not Found (HTTP 404)" >&2
exit 1`);
    const response = await ghApi(process.cwd()).request("GET", "repos/o/r");
    expect(response).toEqual({ status: 404, data: { message: "Not Found" } });
  });

  it("throws when the request never reached GitHub", async () => {
    fakeGh(`echo "error connecting to api.github.com" >&2
exit 1`);
    await expect(ghApi(process.cwd()).request("GET", "user")).rejects.toThrow(
      "error connecting to api.github.com",
    );
  });

  it("explains how to get gh when it is not installed", async () => {
    process.env.PATH = tempProject({});
    await expect(ghApi(process.cwd()).request("GET", "user")).rejects.toThrow(GitHubError);
    await expect(currentRepo(process.cwd())).rejects.toThrow("https://cli.github.com");
  });
});

describe("currentRepo", () => {
  it("asks gh which repo this folder belongs to", async () => {
    fakeGh(`echo "octocat/demo"`);
    await expect(currentRepo(process.cwd())).resolves.toBe("octocat/demo");
  });

  it("asks for --repo when gh cannot tell", async () => {
    fakeGh(`echo "no git remotes found" >&2
exit 1`);
    await expect(currentRepo(process.cwd())).rejects.toThrow("Pass --repo owner/name.");
  });

  it("validates owner/name", () => {
    expect(isRepoName("PatchFarm/the-hollow")).toBe(true);
    expect(isRepoName("a/b/c")).toBe(false);
    expect(isRepoName("../x")).toBe(false);
  });
});
