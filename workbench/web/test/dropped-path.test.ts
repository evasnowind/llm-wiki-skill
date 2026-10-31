import assert from "node:assert/strict";
import test from "node:test";
import { parseDroppedPath } from "../src/lib/dropped-path";

const transfer = (plain: string, uri = "") => ({ getData: (type: string) => type === "text/uri-list" ? uri : plain });

test("dropped local paths support Windows drives, UNC, POSIX and home-relative paths", () => {
	for (const value of ["C:\\资料 空格\\notes", "d:/资料/notes", "\\\\fileserver\\资料 空格\\notes", "//fileserver/资料/notes", "/资料 空格/notes", "~/资料 空格/notes"]) {
		assert.equal(parseDroppedPath(transfer(value)), value);
	}
});

test("file URLs decode filesystem paths without a spurious Windows drive slash", () => {
	for (const [uri, expected] of [
		["file:///C:/%E8%B5%84%E6%96%99%20%E7%A9%BA%E6%A0%BC/notes", "C:/资料 空格/notes"],
		["file://fileserver/share/%E8%B5%84%E6%96%99%20notes", "//fileserver/share/资料 notes"],
		["file:///workspace/fixture/%E8%B5%84%E6%96%99%20notes", "/workspace/fixture/资料 notes"],
		["file://localhost/C:/notes", "C:/notes"],
	]) assert.equal(parseDroppedPath(transfer("", uri)), expected);
});

test("URI-list comments and priority are respected with a safe plain-path fallback", () => {
	assert.equal(parseDroppedPath(transfer("C:\\fallback", "# exported file\r\nfile:///C:/chosen%20folder\r\nfile:///C:/other")), "C:/chosen folder");
	assert.equal(parseDroppedPath(transfer("C:\\fallback", "file:///C:/invalid%escape")), "C:\\fallback");
	assert.equal(parseDroppedPath(transfer("C:\\fallback", "https://example.invalid/path")), "C:\\fallback");
});

test("non-filesystem, drive-relative and malformed URL drops are not accepted", () => {
	for (const value of ["notes", "C:notes", "\\notes", "https://example.invalid/path", "file:///C:/invalid%escape", "# comment", ""]) {
		assert.equal(parseDroppedPath(transfer(value)), null);
	}
});
