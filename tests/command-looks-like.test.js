// P0 fix verification — commandLooksLike* regex must catch absolute / relative paths
// Bug: original regex (^|[;&|()\s])(?:rm|...) missed /bin/rm and ./rm because /
// was not in the boundary character class.  Fix: add / to the leading boundary.
import { describe, it, expect } from "vitest";
import {
  commandLooksLikeDelete,
  commandLooksLikeMoveOrCopy,
  commandLooksLikeCreate,
  commandLooksLikeLocalMutation,
} from "../server/chat/turn-retry-policy.js";

describe("commandLooksLikeDelete — absolute / relative path forms", () => {
  const positives = [
    "rm /tmp/foo",
    "/bin/rm /tmp/foo",
    "/usr/bin/rm -rf /tmp/foo",
    "./rm /tmp/foo",
    "sudo rm /tmp/foo",
    "exec rm /tmp/foo",
    "xargs rm /tmp/foo",
    "rmdir /tmp/foo",
    "/bin/rmdir /tmp/foo",
    "trash /tmp/foo",
    "(rm /tmp/foo)",
    "true && rm /tmp/foo",
    "find /tmp -name '*.log' -delete",
    "shutil.rmtree('/tmp/foo')",
    "os.remove('/tmp/foo')",
    "fs.rmSync('/tmp/foo')",
    "fs.unlink('/tmp/foo', cb)",
  ];
  for (const cmd of positives) {
    it(`detects: ${cmd}`, () => expect(commandLooksLikeDelete(cmd)).toBe(true));
  }

  const negatives = [
    "ls /tmp",
    "cat /etc/passwd",
    "cd /usr/local/lib",
    "echo hello",
    "/usr/bin/cat /etc/permissions",
    "ls /home/me/rmdir-nope",  // rmdir followed by word char, not boundary
  ];
  for (const cmd of negatives) {
    it(`does NOT detect: ${cmd}`, () => expect(commandLooksLikeDelete(cmd)).toBe(false));
  }
});

describe("commandLooksLikeMoveOrCopy — absolute paths", () => {
  const positives = [
    "mv /tmp/a /tmp/b",
    "/bin/mv /tmp/a /tmp/b",
    "/usr/bin/cp -r /tmp/a /tmp/b",
    "./mv /tmp/a /tmp/b",
    "sudo cp /tmp/a /tmp/b",
    "rsync -avh /tmp/a /tmp/b",
    "/usr/local/bin/rsync -a /src /dst",
    "ditto /a /b",
    "shutil.move('/a', '/b')",
    "fs.copyFile('/a', '/b', cb)",
    "os.rename('/a', '/b')",
  ];
  for (const cmd of positives) {
    it(`detects: ${cmd}`, () => expect(commandLooksLikeMoveOrCopy(cmd)).toBe(true));
  }
  // Note: `echo cp` is a known false positive — disambiguating echo args
  // from real cp commands requires a shell parser. Confirmation card is
  // the real safety net.
  const negatives = ["ls /tmp", "cat /etc/cpx", "ls /home/me/cp-archive"];
  for (const cmd of negatives) {
    it(`does NOT detect: ${cmd}`, () => expect(commandLooksLikeMoveOrCopy(cmd)).toBe(false));
  }
});

describe("commandLooksLikeCreate — absolute paths", () => {
  const positives = [
    "mkdir /tmp/foo",
    "/bin/mkdir /tmp/foo",
    "/usr/bin/touch /tmp/foo",
    "./mkdir /tmp/foo",
    "install -d /tmp/foo",
    "/usr/bin/install -d /tmp/foo",
    "echo hi > /tmp/foo",
    "echo hi >> /tmp/foo",
    "fs.writeFile('/tmp/foo', 'data', cb)",
    "Path('/tmp/foo').mkdir()",
  ];
  for (const cmd of positives) {
    it(`detects: ${cmd}`, () => expect(commandLooksLikeCreate(cmd)).toBe(true));
  }
});

describe("commandLooksLikeLocalMutation — absolute paths", () => {
  const positives = [
    "/bin/rm /tmp/foo",
    "/usr/bin/mkdir /tmp/foo",
    "/usr/local/bin/rsync -a /src /dst",
    "./rm /tmp/foo",
  ];
  for (const cmd of positives) {
    it(`detects: ${cmd}`, () => expect(commandLooksLikeLocalMutation(cmd)).toBe(true));
  }
});
