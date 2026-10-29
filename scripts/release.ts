import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Schema } from "effect";

const REPOSITORY = "yoyooyooo/lcu-auto";
const REGISTRY = "https://registry.npmjs.org";
const PACKAGE = "lcu-auto";
const BOOTSTRAP_VERSION = "0.4.0";
const Manifest = Schema.Struct({ name: Schema.String, version: Schema.String });
const VersionDocument = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dist: Schema.Struct({
    integrity: Schema.String,
    attestations: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  }),
});
const PackageCheck = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  archive: Schema.String,
  integrity: Schema.String,
});

function command(name: string, args: string[], capture = false, cwd = process.cwd()) {
  const result = spawnSync(name, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: process.platform === "win32" && name === "npm",
    timeout: 600_000,
  });
  if (result.status !== 0)
    throw new Error(
      `${name} failed (${result.status}); inspect the command output before retrying`,
    );
  return (result.stdout ?? "").trim();
}
function versionNumbers(value: string): number[] {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value))
    throw new Error("Only exact stable x.y.z releases are supported; prereleases are not enabled");
  const numbers = value.split(".").map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part)))
    throw new Error("Version component is out of range");
  return numbers;
}
function isNewer(a: string, b: string): boolean {
  const left = versionNumbers(a);
  const right = versionNumbers(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}
async function registry(path: string): Promise<unknown | undefined> {
  const response = await fetch(`${REGISTRY}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(
      `Registry read failed with HTTP ${response.status}; absence is not established`,
    );
  return response.json();
}
const manifest = Schema.decodeUnknownSync(Manifest)(
  JSON.parse(await readFile("package.json", "utf8")),
);
if (manifest.name !== PACKAGE) throw new Error("Unexpected package name");
versionNumbers(manifest.version);
const tag = `v${manifest.version}`;
const [mode = "--precheck", suppliedTag] = process.argv.slice(2);
if (suppliedTag && suppliedTag !== tag) throw new Error("Tag and package version differ");

async function verifyTag() {
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== REPOSITORY)
    throw new Error("Unexpected GitHub repository");
  command("git", ["fetch", "origin", "main", "--tags"]);
  if (command("git", ["cat-file", "-t", `refs/tags/${tag}`], true) !== "tag")
    throw new Error("Release tag must be annotated");
  const commit = command("git", ["rev-parse", `${tag}^{commit}`], true);
  if (commit !== command("git", ["rev-parse", "HEAD"], true))
    throw new Error("Checkout does not match the tag");
  command("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
  const existing = await registry(`${PACKAGE}/${manifest.version}`);
  if (!existing && commit !== command("git", ["rev-parse", "origin/main"], true))
    throw new Error("A new publish must tag the current origin/main commit");
  console.log(`Verified ${tag} at ${commit}`);
  return commit;
}

async function precheck() {
  if (command("git", ["status", "--porcelain"], true))
    throw new Error("Commit the reviewed source/version/docs before release");
  if (command("git", ["branch", "--show-current"], true) !== "main")
    throw new Error("Release only from main");
  command("git", ["fetch", "origin", "main", "--tags"]);
  if (
    command("git", ["rev-parse", "HEAD"], true) !==
    command("git", ["rev-parse", "origin/main"], true)
  )
    throw new Error("Local main must equal origin/main");
  const existingTag = spawnSync("git", ["show-ref", "--verify", `refs/tags/${tag}`], {
    stdio: "ignore",
  });
  if (existingTag.status === 0) throw new Error(`${tag} already exists; pushed tags are immutable`);
  command("bun", ["run", "check"]);
  command("bun", ["run", "pack:check"]);
  if (command("git", ["status", "--porcelain"], true))
    throw new Error("Checks changed tracked files; review and commit them before tagging");
  const existing = await registry(`${PACKAGE}/${manifest.version}`);
  if (existing && manifest.version !== BOOTSTRAP_VERSION)
    throw new Error("This npm version already exists; bump the version instead of retagging");
  console.log(`Precheck passed for ${tag}; no tag or registry mutation was performed`);
}

async function provenance(
  document: typeof VersionDocument.Type,
  commit: string,
  archive: Uint8Array,
) {
  if (!document.dist.attestations)
    throw new Error("CI-published version is missing npm provenance");
  const url = new URL(document.dist.attestations.url);
  if (url.origin !== REGISTRY) throw new Error("Unexpected provenance endpoint");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Provenance fetch failed: ${response.status}`);
  const data: unknown = await response.json();
  const envelope = Schema.Struct({
    attestations: Schema.Array(
      Schema.Struct({
        predicateType: Schema.String,
        bundle: Schema.Struct({ dsseEnvelope: Schema.Struct({ payload: Schema.String }) }),
      }),
    ),
  });
  const attestations = Schema.decodeUnknownSync(envelope)(data).attestations;
  const item = attestations.find((value) =>
    value.predicateType.startsWith("https://slsa.dev/provenance/"),
  );
  if (!item) throw new Error("No SLSA provenance statement found");
  const raw: unknown = JSON.parse(
    Buffer.from(item.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
  );
  const statement = Schema.decodeUnknownSync(
    Schema.Struct({
      subject: Schema.Array(
        Schema.Struct({ name: Schema.String, digest: Schema.Record(Schema.String, Schema.String) }),
      ),
      predicate: Schema.Unknown,
    }),
  )(raw);
  const digest = createHash("sha512").update(archive).digest("hex");
  if (
    !statement.subject.some(
      (subject) =>
        subject.name === `pkg:npm/${PACKAGE}@${manifest.version}` &&
        subject.digest.sha512 === digest,
    )
  )
    throw new Error("Provenance subject does not match the published tarball");
  const predicate = statement.predicate;
  if (!predicate || typeof predicate !== "object") throw new Error("Invalid provenance predicate");
  const definition: unknown = Reflect.get(predicate, "buildDefinition");
  const invocation: unknown = Reflect.get(predicate, "invocation");
  let bound = false;
  if (definition && typeof definition === "object") {
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({
        externalParameters: Schema.Struct({
          workflow: Schema.Struct({
            repository: Schema.String,
            ref: Schema.String,
            path: Schema.String,
          }),
        }),
        resolvedDependencies: Schema.Array(
          Schema.Struct({
            uri: Schema.String,
            digest: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      }),
    )(definition);
    const workflow = parsed.externalParameters.workflow;
    bound =
      workflow.repository === `https://github.com/${REPOSITORY}` &&
      workflow.path === ".github/workflows/publish.yml" &&
      workflow.ref === `refs/tags/${tag}` &&
      parsed.resolvedDependencies.some(
        (dependency) =>
          dependency.uri.includes(`github.com/${REPOSITORY}`) &&
          (dependency.digest.gitCommit === commit || dependency.digest.sha1 === commit),
      );
  } else if (invocation && typeof invocation === "object") {
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({
        configSource: Schema.Struct({
          uri: Schema.String,
          entryPoint: Schema.String,
          digest: Schema.Record(Schema.String, Schema.String),
        }),
      }),
    )(invocation);
    const source = parsed.configSource;
    bound =
      source.uri === `git+https://github.com/${REPOSITORY}@refs/tags/${tag}` &&
      source.entryPoint === ".github/workflows/publish.yml" &&
      source.digest.sha1 === commit;
  }
  if (!bound)
    throw new Error("Provenance does not bind the expected repository, workflow, tag and commit");
}

async function publish() {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error(
      "Automated publish runs only in GitHub Actions; first local publish uses the documented web-auth lane",
    );
  if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN)
    throw new Error("Do not configure a long-lived npm token; this workflow uses OIDC");
  const commit = await verifyTag();
  const artifact = Schema.decodeUnknownSync(PackageCheck)(
    JSON.parse(await readFile(".artifacts/package-check.json", "utf8")),
  );
  if (artifact.name !== PACKAGE || artifact.version !== manifest.version)
    throw new Error("Packed artifact has the wrong identity");
  const bytes = await readFile(artifact.archive);
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity)
    throw new Error("Packed artifact changed after verification");
  const tags = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
    (await registry(`-/package/${PACKAGE}/dist-tags`)) ?? {},
  );
  if (tags.latest && isNewer(tags.latest, manifest.version))
    throw new Error("Refusing to move latest backward");
  const before = await registry(`${PACKAGE}/${manifest.version}`);
  if (!before)
    command("npm", [
      "publish",
      resolve(artifact.archive),
      "--access",
      "public",
      "--provenance",
      "--tag",
      "latest",
      `--registry=${REGISTRY}/`,
    ]);
  let document: typeof VersionDocument.Type | undefined;
  for (let attempt = 0; attempt < 36; attempt++) {
    const found = await registry(`${PACKAGE}/${manifest.version}`);
    const currentTags = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
      (await registry(`-/package/${PACKAGE}/dist-tags`)) ?? {},
    );
    if (found && currentTags.latest === manifest.version) {
      document = Schema.decodeUnknownSync(VersionDocument)(found);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!document || document.dist.integrity !== artifact.integrity)
    throw new Error(
      "Registry readback is missing or differs from the verified artifact; do not republish blindly",
    );
  const consumer = await mkdtemp(join(tmpdir(), "lcu-auto-registry-"));
  await writeFile(join(consumer, "package.json"), '{"private":true}\n');
  command(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${PACKAGE}@${manifest.version}`,
      `--registry=${REGISTRY}/`,
    ],
    false,
    consumer,
  );
  const version = command(
    "node",
    [join(consumer, "node_modules", PACKAGE, "dist", "cli.js"), "--version"],
    true,
    consumer,
  );
  if (!version.includes(manifest.version))
    throw new Error("Registry-installed CLI did not report the exact version");
  if (manifest.version !== BOOTSTRAP_VERSION || document.dist.attestations) {
    // npm verifies Sigstore/certificate signatures; the check above binds their statement to this exact release.
    command("npm", ["audit", "signatures", `--registry=${REGISTRY}/`], false, consumer);
    await provenance(document, commit, bytes);
  }
  const notes =
    manifest.version === BOOTSTRAP_VERSION && !document.dist.attestations
      ? "Initial maintainer-local web-auth publish. Registry integrity and clean installation verified; this bootstrap artifact has no CI provenance."
      : "Published through npm trusted publishing. Registry integrity, clean installation and signed provenance verified.";
  const release = spawnSync("gh", ["release", "view", tag, "--repo", REPOSITORY], {
    stdio: "ignore",
  });
  if (release.status === 0) {
    const info = JSON.parse(
      command("gh", ["release", "view", tag, "--repo", REPOSITORY, "--json", "assets"], true),
    );
    const assets = Schema.decodeUnknownSync(
      Schema.Struct({ assets: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    )(info).assets;
    if (assets.some((asset) => asset.name === basename(artifact.archive))) {
      const download = await mkdtemp(join(tmpdir(), "lcu-auto-release-asset-"));
      command("gh", [
        "release",
        "download",
        tag,
        "--repo",
        REPOSITORY,
        "--pattern",
        basename(artifact.archive),
        "--dir",
        download,
      ]);
      const existingBytes = await readFile(join(download, basename(artifact.archive)));
      if (
        `sha512-${createHash("sha512").update(existingBytes).digest("base64")}` !==
        artifact.integrity
      )
        throw new Error("Existing GitHub Release asset differs; refusing overwrite");
    } else command("gh", ["release", "upload", tag, artifact.archive, "--repo", REPOSITORY]);
  } else
    command("gh", [
      "release",
      "create",
      tag,
      artifact.archive,
      "--repo",
      REPOSITORY,
      "--verify-tag",
      "--title",
      tag,
      "--notes",
      notes,
    ]);
  console.log(`Registry and GitHub release verified: ${PACKAGE}@${manifest.version}`);
}

if (mode === "--precheck") await precheck();
else if (mode === "--execute") {
  await precheck();
  command("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  command("git", ["push", "origin", `refs/tags/${tag}`]);
} else if (mode === "verify") await verifyTag();
else if (mode === "publish") await publish();
else throw new Error("Use --precheck, --execute, verify <tag>, or publish <tag>");
