import { describe, expect, it } from "vitest";

import {
  sanitizeHeaders,
  sanitizeNetworkUrl,
  sanitizeResponseHeaders,
  summarizePayload,
} from "./network-observer";

describe("NotebookLM network inspector redaction", () => {
  it("keeps protocol routing while removing IDs and secret query values", () => {
    expect(
      sanitizeNetworkUrl(
        "https://notebook.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=AbCdE&token=secret&authuser=0",
      ),
    ).toBe(
      "https://notebook.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=AbCdE&token=%3Credacted%3E&authuser=%3Credacted%3E",
    );
    expect(sanitizeNetworkUrl("https://notebook.google.com/notebook/abcdef1234567890/sources")).toBe(
      "https://notebook.google.com/notebook/<notebook-id>/sources",
    );
  });

  it("never records cookies, authorization, csrf values, or file names", () => {
    expect(
      sanitizeHeaders({
        authorization: "Bearer secret",
        cookie: "SID=secret",
        "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "x-goog-upload-file-name": "private-course.pptx",
        "x-goog-upload-protocol": "raw",
        "x-xsrf-token": "secret",
      }),
    ).toEqual({
      authorization: "<redacted>",
      "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      cookie: "<redacted>",
      "x-goog-upload-file-name": "<redacted>",
      "x-goog-upload-protocol": "raw",
      "x-xsrf-token": "<redacted>",
    });
  });

  it("records the existence of a dynamic upload URL without retaining it", () => {
    expect(
      sanitizeResponseHeaders({
        "set-cookie": "SID=secret",
        "x-goog-upload-status": "active",
        "x-goog-upload-url": "https://notebook.google.com/upload/_/?upload_id=secret",
      }),
    ).toEqual({
      "x-goog-upload-status": "active",
      "x-goog-upload-url": "<dynamic-upload-url>",
    });
  });

  it("keeps form and JSON positions but redacts opaque values", () => {
    const body = Buffer.from(
      new URLSearchParams({
        at: "csrf-secret",
        "f.req": JSON.stringify([["abcdef1234567890", 42, true]]),
      }).toString(),
    );
    expect(summarizePayload(body, "application/x-www-form-urlencoded")).toEqual({
      at: "<redacted>",
      "f.req": [["<opaque-id>", 42, true]],
    });
  });

  it("parses raw JSON mislabeled as form data without retaining file names or IDs", () => {
    const shape = summarizePayload(
      Buffer.from(
        JSON.stringify({
          PROJECT_ID: "822aa4a9-a29e-43f8-a92e-435ef4e2523d",
          SOURCE_ID: "8e5ed842-53c6-4e98-849d-a75c4f2fabc1",
          SOURCE_NAME: "private-course.pptx",
        }),
      ),
      "application/x-www-form-urlencoded",
    );
    expect(shape).toEqual({
      PROJECT_ID: "<opaque-id>",
      SOURCE_ID: "<opaque-id>",
      SOURCE_NAME: "<string>",
    });
  });

  it("preserves nested RPC array positions while redacting serialized values", () => {
    const body = Buffer.from(
      new URLSearchParams({
        "f.req": JSON.stringify([["rpcId", JSON.stringify([["abcdef1234567890"]])]]),
      }).toString(),
    );
    expect(summarizePayload(body, "application/x-www-form-urlencoded")).toEqual({
      "f.req": [["rpcId", { serializedJson: [["<opaque-id>"]] }]],
    });
  });

  it("does not inspect binary file contents", () => {
    expect(summarizePayload(Buffer.from([1, 2, 3]), "application/octet-stream")).toBe("<binary>");
  });

  it("parses length-prefixed batchexecute frames and nested payload JSON", () => {
    const body = Buffer.from(
      `)]}'\n86\n[["wrb.fr","o4cbdc","[[\\"source1234567890\\",1]]",null,null,null,"generic"]]`,
    );
    expect(summarizePayload(body, "application/json")).toEqual({
      framedJson: [
        [["wrb.fr", "o4cbdc", { serializedJson: [["<opaque-id>", 1]] }, null, null, null, "generic"]],
      ],
    });
  });
});
