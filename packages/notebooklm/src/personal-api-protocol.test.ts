import { describe, expect, it } from "vitest";

import {
  ADD_SOURCE_FILE_RPC,
  buildBatchExecuteRequest,
  buildGetNotebookParams,
  buildRegisterFileParams,
  containsOpaqueId,
  decodeBatchExecutePayload,
  extractFirstOpaqueId,
  validateDynamicUploadUrl,
} from "./personal-api-protocol";

describe("NotebookLM personal API protocol", () => {
  it("builds the exact live-captured 2026-08-21 registration shape", () => {
    expect(buildRegisterFileParams("lecture.pptx", "notebook-id-123456")).toEqual([
      [["lecture.pptx"]],
      "notebook-id-123456",
      [2, null, [1], [1, null, null, null, null, null, null, null, null, null, [1, 3]]],
    ]);
  });

  it("builds the live-captured notebook polling shape", () => {
    expect(buildGetNotebookParams("notebook-id-123456")).toEqual([
      "notebook-id-123456",
      null,
      [2, null, [1], [1, null, null, null, null, null, null, null, null, null, [1, 3]]],
      null,
      1,
      [[null, null, []]],
    ]);
  });

  it("reuses runtime tokens without persisting or inventing them", () => {
    const request = buildBatchExecuteRequest(
      {
        at: "runtime-csrf",
        authUser: "7",
        templateUrl:
          "https://notebook.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=rLM1Ne&bl=build&f.sid=sid&_reqid=42&rt=c",
      },
      ADD_SOURCE_FILE_RPC,
      buildRegisterFileParams("lecture.pptx", "notebook-id-123456"),
      "notebook-id-123456",
    );
    const url = new URL(request.url);
    expect(url.searchParams.get("rpcids")).toBe(ADD_SOURCE_FILE_RPC);
    expect(url.searchParams.get("source-path")).toBe("/notebook/notebook-id-123456");
    expect(new URLSearchParams(request.body).get("at")).toBe("runtime-csrf");
  });

  it("decodes a length-prefixed source registration response", () => {
    const sourceId = "source_abcdefghijklmnop";
    const payload = [[[[sourceId], "lecture.pptx", [null, null, null, null, 0]]]];
    const response = `)]}'\n100\n${JSON.stringify([["wrb.fr", ADD_SOURCE_FILE_RPC, JSON.stringify(payload), null, null, null, "generic"]])}`;
    const decoded = decodeBatchExecutePayload(response, ADD_SOURCE_FILE_RPC);
    expect(extractFirstOpaqueId(decoded)).toBe(sourceId);
    expect(containsOpaqueId(decoded, sourceId)).toBe(true);
  });

  it("accepts only same-origin resumable upload session URLs", () => {
    expect(
      validateDynamicUploadUrl(
        "https://notebook.google.com/upload/_/?upload_id=secret&upload_protocol=resumable",
        "https://notebook.google.com",
      ),
    ).toContain("upload_protocol=resumable");
    expect(() =>
      validateDynamicUploadUrl(
        "https://evil.example/upload/_/?upload_id=secret&upload_protocol=resumable",
        "https://notebook.google.com",
      ),
    ).toThrow(/shape changed/);
  });
});
