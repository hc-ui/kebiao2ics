import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWeeks, parseYmd, addDays, mondayOf, generateICS, countEvents, findConflicts } from "../ics.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
