#!/bin/bash
# Unzips any .zip in roms/ (or roms/<console>/) and files each game image into
# roms/<console>/. Console is taken from the zip's folder, else detected from the file.
#
# Usage: ./process-roms.sh            (zips are deleted after a successful import)
#        KEEP_ZIPS=1 ./process-roms.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROMS="$ROOT/roms"
GAME_EXTS="iso rvz wbfs gcm ciso gcz wia wad nsp xci"

for d in wii gamecube; do
    mkdir -p "$ROMS/$d" 2>/dev/null || echo "[ROMS] warning: cannot create $ROMS/$d (permissions? try: sudo chown -R \$USER \"$ROMS\")"
done

extract() { # zip dest
    if command -v unzip >/dev/null 2>&1 && unzip -q -o "$1" -d "$2"; then
        return 0
    fi
    # unzip can't do everything (e.g. archives that are really 7z/RAR); try 7z, then Python
    if command -v 7z >/dev/null 2>&1; then
        7z x -y -o"$2" "$1" >/dev/null
    else
        python3 -I -m zipfile -e "$1" "$2"
    fi
}

describe_file() { # file -> why it isn't a usable zip, or nothing if it looks like a zip
    case "$(hex "$1" 0 4)" in
        504b0304|504b0506) return ;;                       # zip
        377abcaf) echo "it is a 7z archive renamed to .zip (install p7zip-full to import it)" ;;
        52617221) echo "it is a RAR archive renamed to .zip" ;;
        1f8b*) echo "it is a gzip file, not a zip" ;;
        3c21444f|3c68746d|3c48544d) echo "it is an HTML page (a failed download?), not a zip" ;;
        "") echo "it is empty" ;;
        *) echo "it does not start like a zip file (incomplete or corrupt download/copy?)" ;;
    esac
}

hex() { # file offset bytes
    od -An -tx1 -j "$2" -N "$3" "$1" 2>/dev/null | tr -d ' \n'
}

detect_console() { # file -> prints wii|gamecube|switch
    local f="$1" ext="${1##*.}"
    ext="${ext,,}"
    case "$ext" in
        nsp|xci) echo switch; return ;;
        wbfs|wad) echo wii; return ;;
        gcm) echo gamecube; return ;;
        rvz|wia)  # disc type (1=GC, 2=Wii) is a big-endian u32 at 0x48
            case "$(hex "$f" 72 4)" in
                00000001) echo gamecube; return ;;
                00000002) echo wii; return ;;
            esac ;;
        iso|ciso|gcz)
            [ "$(hex "$f" 28 4)" = "c2339f3d" ] && { echo gamecube; return; }
            [ "$(hex "$f" 24 4)" = "5d1c9ea3" ] && { echo wii; return; }
            ;;
    esac
    echo wii
}

processed=0; failed=0

while IFS= read -r -d '' zip; do
    rel="${zip#$ROMS/}"
    parent="$(dirname "$rel")"
    forced=""
    [ "$parent" != "." ] && forced="${parent%%/*}"

    # Skip files still being written (copy or download in progress)
    if [ -n "$(find "$zip" -mmin -1 2>/dev/null)" ]; then
        echo "[ROMS] Skipping $rel: modified in the last minute (still copying?)"
        continue
    fi

    why="$(describe_file "$zip")"
    size="$(stat -c %s "$zip" 2>/dev/null)"
    if [ -n "$why" ] && ! command -v 7z >/dev/null 2>&1; then
        echo "[ROMS] FAILED $rel: $why"
        failed=$((failed + 1)); continue
    fi

    tmp="$(mktemp -d "$ROMS/.extract.XXXXXX")"
    echo "[ROMS] Extracting $rel"
    if ! extract "$zip" "$tmp" 2>/dev/null; then
        echo "[ROMS] FAILED to extract $rel (${size:-?} bytes): ${why:-the archive is corrupt or incomplete; re-download or re-copy it and compare its size}"
        rm -rf "$tmp"; failed=$((failed + 1)); continue
    fi

    found=0; ok=1
    while IFS= read -r -d '' f; do
        ext="${f##*.}"; ext="${ext,,}"
        case " $GAME_EXTS " in *" $ext "*) ;; *) continue ;; esac
        found=$((found + 1))
        console="${forced:-$(detect_console "$f")}"
        mkdir -p "$ROMS/$console"
        dest="$ROMS/$console/$(basename "$f")"
        if [ -e "$dest" ]; then
            echo "[ROMS] Skipping $(basename "$f"): already exists in $console/"
            continue
        fi
        if mv "$f" "$dest"; then
            echo "[ROMS] Added $console/$(basename "$f")"
        else
            ok=0
        fi
    done < <(find "$tmp" -type f -print0)

    rm -rf "$tmp"
    if [ "$found" -eq 0 ]; then
        echo "[ROMS] No game files (${GAME_EXTS}) in $rel; leaving it alone"
        failed=$((failed + 1))
    elif [ "$ok" -eq 1 ]; then
        processed=$((processed + 1))
        [ -z "$KEEP_ZIPS" ] && rm -f "$zip"
    else
        failed=$((failed + 1))
    fi
done < <(find "$ROMS" -name '.*' -prune -o -type f -iname '*.zip' -print0)

echo "[ROMS] Done: $processed zip(s) imported, $failed problem(s)"
[ "$failed" -eq 0 ]
