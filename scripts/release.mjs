// Релиз council как плагина opencode, без npm-реестра.
//
//   node scripts/release.mjs --tag v0.1.0   коммит «исходники + dist» поверх HEAD и git-тег;
//                                            дальше: git push origin v0.1.0, у пользователя —
//                                            opencode plugin add git+https://<git>/council-mcp.git#v0.1.0
//   node scripts/release.mjs --dir <путь>    готовый git-репозиторий плагина в папке (передача
//                                            без сети): opencode plugin add git+file://<путь>
//
// В релизе package.json без зависимостей и скриптов: бандлы самодостаточны, и `npm install`
// из git (так ставит opencode) ничего не скачивает из реестра и ничего не собирает.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tag = opt("--tag");
const dir = opt("--dir");
if (!tag === !dir) {
  console.error("Использование: node scripts/release.mjs --tag vX.Y.Z | --dir <путь>");
  process.exit(2);
}
if (tag && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`Тег должен выглядеть как v0.1.0, а не «${tag}»`);
  process.exit(2);
}

const run = (cmd, argv, cwd = root) =>
  execFileSync(cmd, argv, { cwd, stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();
const git = (argv, cwd = root) => run("git", argv, cwd);
const commitEnv = ["-c", "user.name=council-release", "-c", "user.email=release@council.local"];

const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = tag ? tag.slice(1) : source.version;

/** package.json плагина: точка входа — плагин opencode, CLI — bin; без зависимостей. */
function releaseManifest() {
  return `${JSON.stringify(
    {
      name: source.name,
      version,
      description: source.description,
      type: "module",
      engines: source.engines,
      main: "./dist/opencode/plugin.js",
      exports: { ".": "./dist/opencode/plugin.js", "./server": "./dist/opencode/plugin.js" },
      bin: { council: "dist/cli/index.js" },
      files: ["dist", "README.md", "integrations"],
    },
    null,
    2,
  )}\n`;
}

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

if (tag) {
  if (git(["status", "--porcelain"]) !== "") {
    console.error("Рабочая копия не чистая: закоммитьте изменения перед релизом.");
    process.exit(1);
  }
  if (git(["tag", "--list", tag]) !== "") {
    console.error(`Тег ${tag} уже есть.`);
    process.exit(1);
  }
  // Отдельный worktree от HEAD: ветка разработки не меняется, dist в неё не попадает.
  const wt = mkdtempSync(join(tmpdir(), "council-release-"));
  try {
    git(["worktree", "add", "--detach", wt, "HEAD"]);
    cpSync(join(root, "dist"), join(wt, "dist"), { recursive: true });
    writeFileSync(join(wt, "package.json"), releaseManifest());
    rmSync(join(wt, "package-lock.json"), { force: true });
    git(["add", "-A", "-f", "dist", "package.json", "package-lock.json"], wt);
    git([...commitEnv, "commit", "-q", "-m", `release ${tag}`], wt);
    git(["tag", "-a", tag, "-m", `council ${tag}`], wt);
  } finally {
    git(["worktree", "remove", "--force", wt]);
  }
  console.log(`Готово: тег ${tag}. Опубликуйте: git push origin ${tag}`);
  console.log(`Установка: opencode plugin add git+https://<ваш git>/council-mcp.git#${tag}`);
} else {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  if (!existsSync(join(out, ".git"))) git(["init", "-q"], out);
  for (const name of ["dist", "integrations", "README.md"]) {
    rmSync(join(out, name), { recursive: true, force: true });
    cpSync(join(root, name), join(out, name), { recursive: true });
  }
  writeFileSync(join(out, "package.json"), releaseManifest());
  git(["add", "-A"], out);
  if (git(["status", "--porcelain"], out) !== "")
    git([...commitEnv, "commit", "-q", "-m", `council ${version}`], out);
  console.log(`Готово: ${out}`);
  console.log(`Установка: opencode plugin add git+file://${out}`);
}
