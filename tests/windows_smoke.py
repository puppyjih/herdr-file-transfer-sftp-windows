"""Focused Windows-port checks; uses disposable files, never a user's remote host."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

HELPER = Path(__file__).resolve().parents[1] / "mods/files-transfer-windows/windows.ps1"


def call(action, **data):
    payload = dict(data, action=action)
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-STA", "-NonInteractive", "-File",
         str(HELPER), "-RequestJson", json.dumps(payload, ensure_ascii=True)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    if result.returncode:
        raise RuntimeError(f"{action}: {result.stderr} {result.stdout}")
    return json.loads(result.stdout)


def main():
    with tempfile.TemporaryDirectory(prefix="herdr-win-test-") as temp:
        root = Path(temp)
        app = root / "app"
        destination = root / "destination [brackets]"
        destination.mkdir()
        source = root / "source ' quote"
        source.mkdir()
        name = "\ud55c\uae00 [a] $().txt"
        file = source / name
        file.write_text("hello \ud55c\uae00", encoding="utf-8")
        nested = source / "nested"
        nested.mkdir()
        (nested / ".hidden").write_text("hidden")
        (nested / "normal.txt").write_text("normal")
        rows = call("list", path=str(source))
        assert len(rows) == 2
        stamp = next(row["mtime"] for row in rows if row["name"] == name)
        assert abs(stamp - file.stat().st_mtime * 1000) < 1000
        assert next(row["size"] for row in rows if row["name"] == name) == file.stat().st_size
        fresh = destination / "new.txt"
        call("new-file", path=str(fresh))
        try:
            call("new-file", path=str(fresh))
        except RuntimeError:
            pass
        else:
            raise AssertionError("overwrite accepted")
        renamed = destination / "renamed.txt"
        call("rename", path=str(fresh), to=str(renamed))
        assert renamed.exists()
        call("new-folder", path=str(destination / "new folder"))

        def transfer(kind, **kwargs):
            status = app / "data/files-transfer-windows" / ("win-" + str(time.time_ns()))
            call("start", appHome=str(app), script=str(HELPER), status=str(status), kind=kind, **kwargs)
            for _ in range(100):
                result = call("status", appHome=str(app), status=str(status))
                if result["code"] is not None:
                    break
                time.sleep(.1)
            assert result["code"] == "0", result
            call("status-clean", appHome=str(app), status=str(status))
            return result

        for _ in range(2):
            transfer("download", source=str(file), remote=False, name=file.name, destination=str(destination))
        assert (destination / name).read_bytes() == file.read_bytes()
        assert (destination / name.replace(".txt", " (1).txt")).exists()
        transfer("upload-local", sources=[str(file), str(nested)], destination=str(destination))
        assert (destination / "nested/.hidden").read_text() == "hidden"
        assert (destination / name.replace(".txt", " (2).txt")).exists()
        assert not list(destination.glob(".herdr-*"))

        # Poll a real staging file, then cancel its job before publication.
        status = app / "data/files-transfer-windows/win-cancel-test"
        request_file = status.with_suffix(".request.json")
        progress_file = status.with_suffix(".progress")
        request_file.write_text(json.dumps({
            "appHome": str(app), "status": str(status), "kind": "download",
            "source": str(file), "destination": str(destination), "name": "cancelled.txt",
        }), encoding="utf-8")
        progress_file.write_text(json.dumps({"path": str(file), "total": 100}), encoding="utf-8")
        progress = call("status", appHome=str(app), status=str(status))
        assert progress == {"code": None, "bytes": file.stat().st_size, "total": 100}, progress
        call("cancel", appHome=str(app), status=str(status))
        call("worker-file", requestFile=str(request_file))
        assert call("status", appHome=str(app), status=str(status))["code"] == "2"
        assert not (destination / "cancelled.txt").exists()
        call("status-clean", appHome=str(app), status=str(status))
        assert not list(status.parent.glob("win-cancel-test*"))

        stage = call("stage-create", path=str(destination))
        (Path(stage) / name).write_text("remote")
        assert call("stage-place", path=stage, destination=str(destination)) == [name.replace(".txt", " (3).txt")]
        for operation, values in [
            ("stage-remove", dict(path=str(source), destination=str(destination))),
            ("new-file", dict(path=str(destination / "CON.txt"))),
        ]:
            try:
                call(operation, **values)
            except RuntimeError:
                pass
            else:
                raise AssertionError("invalid path accepted")
        # Exercise the compact remote-host script in the same EncodedCommand form.
        remote_script = HELPER.with_name("windows-remote.ps1").read_text(encoding="utf-8")
        import base64

        def remote_call(action, **data):
            payload = json.dumps(dict(data, action=action), ensure_ascii=True).replace("'", "''")
            command = "& { " + remote_script + " } '" + payload + "'"
            encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
            assert len(encoded) < 30000, "remote helper exceeds Windows command-line limit"
            r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
            if r.returncode:
                raise RuntimeError(r.stderr)
            return json.loads(r.stdout)

        remote_stage = remote_call("stage-create", path=str(destination))
        (Path(remote_stage) / "from remote.txt").write_text("remote")
        assert remote_call("stage-place", path=remote_stage, destination=str(destination)) == ["from remote.txt"]
        remote_rows = remote_call("list", path=str(destination))
        assert next(row["size"] for row in remote_rows if row["name"] == "from remote.txt") == 6
        assert remote_call("tree-bytes", path=str(destination)) > 6
        print("PASS: Unicode, brackets, quotes, create/rename, overwrite rejection, detached transfers, duplicate names, dotfiles, remote-Windows finalization, staging boundaries")


def remote_smoke(machine):
    """Opt-in SCP roundtrip, only under a newly created /tmp directory."""
    core = Path(os.environ["LOCALAPPDATA"]) / "Programs/herdr-core/hc.exe"

    def hc(*args):
        r = subprocess.run([str(core), *args], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=40)
        if r.returncode:
            raise RuntimeError(r.stderr or r.stdout)
        return r.stdout.strip()

    machines = json.loads(hc("machine", "ls", "--json"))["machines"]
    target = next(m["target"] for m in machines if m["name"] == machine)
    platform = hc("exec", "--on", machine, "python3", "-c", "import sys;print(sys.platform)")
    if platform != "linux":
        raise RuntimeError("This opt-in transport check expects a Linux /tmp test host")
    remote = hc("exec", "--on", machine, "mktemp", "-d", "/tmp/herdr-transfer-test.XXXXXXXX")
    if not remote.startswith("/tmp/herdr-transfer-test.") or "/" in remote[len("/tmp/"):]:
        raise RuntimeError("Unexpected temporary directory")
    try:
        with tempfile.TemporaryDirectory(prefix="herdr-scp-test-") as temp:
            root = Path(temp)
            app = root / "app"
            source = root / "source"
            source.mkdir()
            file = source / "\ud55c\uae00 [a] ' quote.txt"
            file.write_text("SCP roundtrip \ud55c\uae00", encoding="utf-8")

            def transfer(kind, **values):
                status = app / "data/files-transfer-windows" / ("win-" + str(time.time_ns()))
                call("start", appHome=str(app), script=str(HELPER), status=str(status), kind=kind, **values)
                for _ in range(100):
                    result = call("status", appHome=str(app), status=str(status))
                    if result["code"] is not None:
                        break
                    time.sleep(.15)
                assert result["code"] == "0", result["log"]
                call("status-clean", appHome=str(app), status=str(status))

            transfer("upload-remote", sources=[str(file)], destination=target + ":" + remote + "/")
            download = root / "download"
            transfer("download", remote=True, source=target + ":" + remote + "/" + file.name,
                     name=file.name, destination=str(download))
            assert (download / file.name).read_bytes() == file.read_bytes()
            print("PASS: actual Windows-to-Linux SCP upload/download, Unicode/brackets/apostrophe filename, byte-identical roundtrip")
    finally:
        hc("exec", "--on", machine, "python3", "-c",
           "import os,sys,shutil; p=os.path.realpath(sys.argv[1]); "
           "assert os.path.dirname(p)=='/tmp' and os.path.basename(p).startswith('herdr-transfer-test.'); shutil.rmtree(p)", remote)


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "--remote-machine":
        remote_smoke(sys.argv[2])
    else:
        main()
