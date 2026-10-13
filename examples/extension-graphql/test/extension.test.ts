import { describe, expect, it } from "vitest";
import { ExtensionPermissionError } from "@dev-learning-ai/core";
import { activateExtension } from "@dev-learning-ai/runtime";
import extension, { reportToCsv } from "../src/index.js";
import { openService, tempDir } from "../../../packages/runtime/test/helpers.js";

describe("extension contract (example-graphql)", () => {
  it("declares a supported API version and the permissions it uses", () => {
    expect(extension.apiVersion).toBe(1);
    expect(extension.permissions).toEqual(["write-knowledge", "reports"]);
  });

  it("is refused without the permissions the user granted", async () => {
    const svc = await openService(await tempDir());
    const sink = { exporters: [], resourceProviders: [] };
    await expect(activateExtension(svc, extension, [], sink)).rejects.toBeInstanceOf(
      ExtensionPermissionError,
    );
    expect((await svc.catalog()).has("graphql.n-plus-one")).toBe(false);
  });

  it("registers validated concepts and an exporter when permitted", async () => {
    const svc = await openService(await tempDir());
    const sink = { exporters: [] as { id: string }[], resourceProviders: [] };
    await activateExtension(svc, extension, ["write-knowledge", "reports"], sink as never);
    const catalog = await svc.catalog();
    expect(catalog.get("graphql.n-plus-one")?.parent).toBe("graphql");
    expect(sink.exporters.map((e) => e.id)).toEqual(["csv"]);
    // New concepts are immediately usable by detection and runtime generation.
    expect(catalog.forTechnology("graphql")).toHaveLength(2);
  });

  it("refuses an unsupported API version", async () => {
    const svc = await openService(await tempDir());
    await expect(
      activateExtension(svc, { ...extension, apiVersion: 99 }, ["write-knowledge", "reports"], {
        exporters: [],
        resourceProviders: [],
      }),
    ).rejects.toThrow(/API v99/);
  });

  it("exports reports as CSV with escaping", () => {
    const csv = reportToCsv({
      title: "t",
      period: { from: "a", to: "b" },
      sections: [
        { heading: "Activity", observed: ['3 tasks, "2" with questions'], estimated: ["retention ~70%"] },
      ],
    });
    expect(csv.split("\n")).toEqual([
      "section,kind,text",
      'Activity,observed,"3 tasks, ""2"" with questions"',
      "Activity,estimated,retention ~70%",
    ]);
  });
});
