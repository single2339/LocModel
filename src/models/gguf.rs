use serde_json::{json, Map, Value};
use std::{
    fs::{self, File},
    io::{self, BufReader, Read, Seek},
    path::{Path, PathBuf},
};

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "GGUF 文件头损坏或不受支持")
}
fn bytes<const N: usize>(r: &mut impl Read) -> io::Result<[u8; N]> {
    let mut b = [0; N];
    r.read_exact(&mut b)?;
    Ok(b)
}
fn length(r: &mut impl Read) -> io::Result<u64> {
    Ok(u64::from_le_bytes(bytes(r)?))
}
fn string(r: &mut impl Read) -> io::Result<String> {
    let n = length(r)?;
    if n > 1024 * 1024 {
        return Err(invalid());
    }
    let mut b = vec![0; n as usize];
    r.read_exact(&mut b)?;
    String::from_utf8(b).map_err(|_| invalid())
}
fn skip(r: &mut (impl Read + Seek), kind: u32, n: u64) -> io::Result<()> {
    let width = match kind {
        0 | 1 | 7 => 1,
        2 | 3 => 2,
        4..=6 => 4,
        10..=12 => 8,
        8 => {
            if n > 16_000_000 {
                return Err(invalid());
            }
            for _ in 0..n {
                let size = length(r)?;
                r.seek_relative(i64::try_from(size).map_err(|_| invalid())?)?;
            }
            return Ok(());
        }
        _ => return Err(invalid()),
    };
    let count = n
        .checked_mul(width)
        .and_then(|x| i64::try_from(x).ok())
        .ok_or_else(invalid)?;
    r.seek_relative(count)?;
    Ok(())
}
pub fn metadata(path: &Path) -> io::Result<Value> {
    let mut r = BufReader::new(File::open(path)?);
    if &bytes::<4>(&mut r)? != b"GGUF" || !(2..=3).contains(&u32::from_le_bytes(bytes(&mut r)?)) {
        return Err(invalid());
    }
    let _tensors = length(&mut r)?;
    let count = length(&mut r)?;
    if count > 100_000 {
        return Err(invalid());
    }
    let mut map = Map::new();
    for _ in 0..count {
        let key = string(&mut r)?;
        let kind = u32::from_le_bytes(bytes(&mut r)?);
        let val = match kind {
            9 => {
                let ty = u32::from_le_bytes(bytes(&mut r)?);
                let n = length(&mut r)?;
                skip(&mut r, ty, n)?;
                continue;
            }
            8 if key == "general.architecture" || key == "general.name" => json!(string(&mut r)?),
            4 => json!(u32::from_le_bytes(bytes(&mut r)?)),
            2 => json!(u16::from_le_bytes(bytes(&mut r)?)),
            10 => json!(length(&mut r)?),
            _ => {
                skip(&mut r, kind, 1)?;
                continue;
            }
        };
        map.insert(key, val);
    }
    if r.stream_position()? > r.get_ref().metadata()?.len() {
        return Err(invalid());
    }
    Ok(Value::Object(map))
}
pub fn shards(p: &Path) -> io::Result<Vec<PathBuf>> {
    let name = p.file_name().and_then(|s| s.to_str()).ok_or_else(invalid)?;
    let stem = name.strip_suffix(".gguf").unwrap_or(name);
    if let Some((prefix_idx, total)) = stem.rsplit_once("-of-") {
        if let Some((prefix, idx)) = prefix_idx.rsplit_once('-') {
            if total.len() == 5 && idx.len() == 5 && idx.bytes().all(|b| b.is_ascii_digit()) {
                let max: usize = total.parse().map_err(|_| invalid())?;
                if max == 0 || max > 4096 {
                    return Err(invalid());
                }
                return Ok((1..=max)
                    .map(|i| p.with_file_name(format!("{prefix}-{i:05}-of-{max:05}.gguf")))
                    .collect());
            }
        }
    }
    Ok(vec![p.to_owned()])
}
pub fn quant(name: &str) -> String {
    let name = name.to_ascii_uppercase();
    let stem = name.strip_suffix(".GGUF").unwrap_or(&name);
    let tokens = stem.split(['-', '.', '/']).collect::<Vec<_>>();
    for (i, t) in tokens.iter().enumerate().rev() {
        let s = t.strip_prefix('I').unwrap_or(t);
        if ["F16", "BF16", "F32", "MXFP4"].contains(t)
            || s.strip_prefix('Q')
                .and_then(|q| q.as_bytes().first())
                .is_some_and(u8::is_ascii_digit)
        {
            return if i > 0 && tokens[i - 1] == "UD" {
                format!("UD-{t}")
            } else {
                t.to_string()
            };
        }
    }
    stem.rsplit('/').next().unwrap_or(stem).to_owned()
}
pub fn describe(
    path: &Path,
    imported: bool,
    repo: &Value,
    projector: &Value,
) -> Result<Value, String> {
    let files = shards(path).map_err(|e| e.to_string())?;
    let path = &files[0];
    let meta = metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let arch = meta["general.architecture"].as_str().unwrap_or("unknown");
    let field = |name: &str| meta[format!("{arch}.{name}")].as_u64().unwrap_or(0);
    let size = files
        .iter()
        .try_fold(0u64, |total, p| fs::metadata(p).map(|m| total + m.len()))
        .map_err(|e| format!("GGUF 分卷不可用: {e}"))?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let names = [
        "F32",
        "F16",
        "Q4_0",
        "Q4_1",
        "-",
        "-",
        "-",
        "Q8_0",
        "Q5_0",
        "Q5_1",
        "Q2_K",
        "Q3_K_S",
        "Q3_K_M",
        "Q3_K_L",
        "Q4_K_S",
        "Q4_K_M",
        "Q5_K_S",
        "Q5_K_M",
        "Q6_K",
        "IQ2_XXS",
        "IQ2_XS",
        "Q2_K_S",
        "IQ3_XS",
        "IQ3_XXS",
        "IQ1_S",
        "IQ4_NL",
        "IQ3_S",
        "IQ3_M",
        "IQ2_S",
        "IQ2_M",
        "IQ4_XS",
        "IQ1_M",
        "BF16",
        "-",
        "-",
        "-",
        "TQ1_0",
        "TQ2_0",
        "MXFP4_MOE",
        "NVFP4",
        "Q1_0",
        "Q2_0",
        "F8_E4M3",
    ];
    let quant_name = quant(stem);
    let file_type = if quant_name.starts_with("UD-") {
        quant_name.as_str()
    } else {
        meta["general.file_type"]
            .as_u64()
            .and_then(|n| names.get(n as usize))
            .copied()
            .filter(|s| *s != "-")
            .unwrap_or(&quant_name)
    };
    let mm = projector
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| {
            let mut candidates: Vec<_> = fs::read_dir(path.parent()?)
                .ok()?
                .flatten()
                .map(|e| e.path())
                .filter(|p| is_projector(p))
                .collect();
            candidates.sort();
            (candidates.len() == 1).then(|| candidates.remove(0))
        });
    Ok(
        json!({"path":path,"name":meta["general.name"].as_str().unwrap_or(stem),"imported":imported,"repo":repo,"mmproj":mm,
        "info":{"arch":arch,"file_type":file_type,"files":files,"total_bytes":size,"block_count":field("block_count"),"expert_count":field("expert_count"),
        "expert_used_count":field("expert_used_count"),"ctx_max":field("context_length"),"is_diffusion":arch.contains("diffusion")||arch=="flux"||arch=="sd3"}}),
    )
}
pub fn is_projector(path: &Path) -> bool {
    path.file_name().and_then(|s| s.to_str()).is_some_and(|s| {
        let name = s.to_ascii_lowercase();
        name.contains("mmproj") && name.ends_with(".gguf")
    })
}
