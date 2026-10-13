#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { globSync } from "node:fs";
for (const p of [
  ...globSync("{packages,apps,examples}/*/dist"),
  ...globSync("{packages,apps,examples}/*/tsconfig.tsbuildinfo"),
]) {
  await rm(p, { recursive: true, force: true });
}
console.log("cleaned build output");
