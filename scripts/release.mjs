// Копия плагина council для передачи без сети (например, в закрытый контур):
//
//   node scripts/release.mjs --dir <путь>    git-репозиторий с файлами пакета в папке;
//                                            установка: opencode plugin add git+file://<путь>
//
// Обычная установка этого не требует: репозиторий сам является пакетом (dist/ закоммичен),
// `opencode plugin add git+https://<git>/council-mcp.git` ставит его напрямую. Версию
// закрепляет тег: `git tag v0.1.0 && git push origin v0.1.0`, установка — `…council-mcp.git#v0.1.0`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf("--dir");
const dir = i >= 0 ? args[i + 1] : undefined;
if (!dir) {
  console.error("Использование: node scripts/release.mjs --dir <путь>");
  process.exit(2);
}

const git = (argv, cwd) =>
  execFileSync("git", argv, { cwd, stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = resolve(dir);
mkdirSync(out, { recursive: true });
if (!existsSync(join(out, ".git"))) git(["init", "-q"], out);
for (const name of ["package.json", ...pkg.files]) {
  rmSync(join(out, name), { recursive: true, force: true });
  cpSync(join(root, name), join(out, name), { recursive: true });
}
git(["add", "-A"], out);
if (git(["status", "--porcelain"], out) !== "")
  git(
    [
      "-c",
      "user.name=council-release",
      "-c",
      "user.email=release@council.local",
      "commit",
      "-q",
      "-m",
      `council ${String(pkg.version)}`,
    ],
    out,
  );
console.log(`Готово: ${out}`);
console.log(`Установка: opencode plugin add git+file://${out}`);
