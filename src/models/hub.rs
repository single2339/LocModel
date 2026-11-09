use super::*;
use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Hub<'a>(routes::Routes<'a>);
impl<'a> Hub<'a> {
    fn new(ctx: &'a Ctx) -> Result<Self, String> {
        routes::Routes::new(ctx).map(Self)
    }
    fn json(&self, parts: &[&str], query: &[(&str, &str)]) -> Reply {
        self.0
            .fetch(true, parts, query, None)?
            .0
            .json()
            .map_err(|e| e.without_url().to_string())
    }
    fn search(&self, q: &str) -> Reply {
        let v = self.json(
            &["models"],
            &[
                ("search", q),
                ("filter", "gguf"),
                ("sort", "downloads"),
                ("direction", "-1"),
                ("limit", "50"),
            ],
        )?;
        Ok(json!(v.as_array().ok_or("搜索结果无效")?.iter().filter_map(|x|Some(json!({"id":x["id"].as_str()?,"downloads":x["downloads"].as_u64().unwrap_or(0),"likes":x["likes"].as_u64().unwrap_or(0)}))).collect::<Vec<_>>()))
    }
    fn repo(&self, repo: &str) -> Result<Repository, String> {
        if repo.split('/').count() != 2 {
            return Err("请使用 作者/仓库 格式".into());
        }
        let result = self.json(&["models", repo], &[("blobs", "true")])?;
        Repository::parse(&result)
    }
}
struct Repository {
    revision: String,
    quants: BTreeMap<String, Vec<Value>>,
    projectors: Vec<Value>,
}
impl Repository {
    fn parse(value: &Value) -> Result<Self, String> {
        let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut projectors = vec![];
        for f in value["siblings"].as_array().ok_or("仓库文件列表无效")? {
            let Some(name) = f["rfilename"].as_str() else {
                continue;
            };
            if !name.to_ascii_lowercase().ends_with(".gguf") {
                continue;
            }
            routes::validate_path(name)?;
            let path = Path::new(name);
            let file = json!({"sha256":f["lfs"]["sha256"],"name":name,"bytes":f["size"].as_u64().or_else(||f["lfs"]["size"].as_u64()).unwrap_or(0)});
            if gguf::is_projector(path) {
                projectors.push(file);
                continue;
            }
            let stem = name.strip_suffix(".gguf").unwrap_or(name);
            let group = stem
                .rsplit_once("-of-")
                .and_then(|(a, b)| {
                    let (base, idx) = a.rsplit_once('-')?;
                    (idx.len() == 5
                        && b.len() == 5
                        && idx.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit()))
                    .then_some(base)
                })
                .unwrap_or(stem);
            groups.entry(group.into()).or_default().push(file)
        }
        let mut quants = BTreeMap::new();
        for (stem, mut files) in groups {
            files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            let q = gguf::quant(&stem);
            let key = if quants.contains_key(&q) { stem } else { q };
            quants.insert(key, files);
        }
        projectors.sort_by_key(|f| {
            let n = f["name"].as_str().unwrap_or("").to_ascii_uppercase();
            (!n.contains("F16"), f["bytes"].as_u64().unwrap_or(0))
        });
        let sha = value["sha"]
            .as_str()
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("无效仓库版本")?;
        Ok(Self {
            revision: sha.into(),
            quants,
            projectors,
        })
    }
    fn rows(&self, ctx: &Ctx) -> Reply {
        let cap = Capacity::read(ctx)?;
        Ok(json!(self.quants.iter().map(|(q,files)|{let bytes=total(files);let p=cap.plan(bytes,8192);
            json!({"quant":q,"files":files,"bytes":bytes,"tier":p["tier"],"tier_label":p["tier_label"],"est_tps":p["est_tps"]})
        }).collect::<Vec<_>>()))
    }
}
fn total(files: &[Value]) -> u64 {
    files.iter().filter_map(|f| f["bytes"].as_u64()).sum()
}
fn digest_matches(path: &Path, expected: &str) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest).map_err(|e| e.to_string())?;
    Ok(expected.eq_ignore_ascii_case(&format!("{:x}", digest.finalize())))
}

fn transfer(
    h: &Hub,
    repo: &str,
    rev: &str,
    files: &[Value],
    dir: &Path,
    id: &str,
    cancel: &AtomicBool,
    emit: impl Fn(Value),
) -> Result<Vec<PathBuf>, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let total = total(files);
    let mut done = 0;
    let mut received = 0u64;
    let start = Instant::now();
    let mut last = Instant::now();
    let mut paths = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let name = argument(f, "name")?;
        routes::validate_path(name)?;
        let leaf = name.rsplit('/').next().ok_or("无效文件名")?;
        let path = dir.join(leaf);
        if paths.contains(&path) {
            return Err("仓库文件重名".into());
        }
        paths.push(path.clone());
        let expected = f["bytes"].as_u64().unwrap_or(0);
        let digest = f["sha256"].as_str();
        if expected > 0
            && path.metadata().is_ok_and(|m| m.len() == expected)
            && match digest {
                Some(sha) => digest_matches(&path, sha)?,
                None => true,
            }
        {
            done += expected;
            continue;
        }
        let part = dir.join(format!("{leaf}.{rev}.part"));
        let validator = dir.join(format!("{leaf}.{rev}.part.etag"));
        let offset = part.metadata().map(|m| m.len()).unwrap_or(0);
        if cancel.load(Ordering::Relaxed) {
            return Err("已暂停下载".into());
        }
        if expected == 0 || offset != expected {
            // An empty marker means the last response used a mutable URL without a strong ETag.
            // Older partials without a marker were downloaded from a commit-pinned Hub URL.
            let saved = match fs::read_to_string(&validator) {
                Ok(tag) => Some(tag),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string()),
            };
            let resume =
                offset > 0 && (expected == 0 || offset < expected) && saved.as_deref() != Some("");
            let parts = [repo, "resolve", rev, name];
            let (mut response, mut route) = h.0.fetch(
                false,
                &parts,
                &[],
                resume.then_some((offset, saved.as_deref())),
            )?;
            if resume && response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
                (response, route) = h.0.fetch(false, &parts, &[], None)?;
            }
            let partial = resume && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
            if partial
                && !response
                    .headers()
                    .get("content-range")
                    .and_then(|s| s.to_str().ok())
                    .is_some_and(|s| s.starts_with(&format!("bytes {offset}-")))
            {
                return Err("续传范围不匹配".into());
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .append(partial)
                .truncate(!partial)
                .open(&part)
                .map_err(|e| e.to_string())?;
            if let Some(tag) = routes::strong_etag(&response) {
                fs::write(&validator, tag).map_err(|e| e.to_string())?;
            } else if route == "高速下载" {
                fs::write(&validator, "").map_err(|e| e.to_string())?;
            } else if validator.exists() {
                fs::remove_file(&validator).map_err(|e| e.to_string())?;
            }
            if partial {
                done += offset
            }
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("已暂停下载".into());
                }
                let n = response.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                received += n as u64;
                done += n as u64;
                if last.elapsed() >= Duration::from_millis(200) {
                    emit(
                        json!({"id":id,"status":"downloading","done":done,"total":total,"speed":received as f64/start.elapsed().as_secs_f64(),"file_index":i,"file_count":files.len(),"route":route}),
                    );
                    last = Instant::now();
                }
            }
            file.flush().map_err(|e| e.to_string())?;
        } else {
            done += offset
        }
        if expected > 0 && part.metadata().map_err(|e| e.to_string())?.len() != expected {
            return Err("下载不完整，请重试".into());
        }
        let mut magic = [0; 4];
        fs::File::open(&part)
            .and_then(|mut f| f.read_exact(&mut magic))
            .map_err(|e| e.to_string())?;
        if &magic != b"GGUF" {
            let _ = fs::remove_file(&part);
            return Err("下载的文件不是 GGUF".into());
        }
        if let Some(sha) = digest {
            if !digest_matches(&part, sha)? {
                fs::remove_file(&part).map_err(|e| e.to_string())?;
                let _ = fs::remove_file(&validator);
                return Err("模型 SHA-256 校验失败，请重试".into());
            }
        }
        fs::rename(&part, &path).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(validator);
    }
    Ok(paths)
}
fn download(cmd: &str, a: &Value, ctx: &Ctx, h: &Hub, app: &tauri::AppHandle) -> Reply {
    let projector_only = cmd == "fetch_mmproj";
    let model = if projector_only {
        lookup(ctx, argument(a, "path")?)?
    } else {
        Value::Null
    };
    let repo = argument(if projector_only { &model } else { a }, "repo")?;
    let quant = if projector_only {
        "mmproj"
    } else {
        argument(a, "quant")?
    };
    let id = format!("{repo}:{quant}");
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS.lock().map_err(|e| e.to_string())?;
        if jobs.contains_key(&id) {
            return Err("此下载正在进行".into());
        }
        jobs.insert(id.clone(), flag.clone());
    }
    let result = (|| {
        let r = h.repo(repo)?;
        let mut files = if projector_only {
            vec![]
        } else {
            r.quants.get(quant).ok_or("仓库中没有此量化")?.clone()
        };
        if projector_only || a["vision"] == true {
            if let Some(f) = r.projectors.first() {
                files.push(f.clone())
            } else if projector_only {
                return Err("NO_MMPROJ|仓库未提供看图组件".into());
            }
        }
        // Hex encoding keeps remote identifiers distinct on case-insensitive filesystems.
        let safe = |s: &str| {
            s.as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        let dir = if projector_only {
            Path::new(argument(&model, "path")?)
                .parent()
                .ok_or("模型目录无效")?
                .to_owned()
        } else {
            base(ctx)?.join(repo.replace('/', "--")).join(safe(quant))
        };
        let paths = transfer(h, repo, &r.revision, &files, &dir, &id, &flag, |progress| {
            let _ = app.emit("download-progress", progress);
        })?;
        if projector_only {
            let key = argument(a, "path")?;
            update(ctx, |rows| {
                if rows[key].is_null() {
                    return Err("模型已移除".into());
                }
                rows[key]["mmproj"] = json!(paths[0]);
                rows[key]["owned_projector"] = json!(paths[0]);
                Ok(())
            })?;
            Ok(json!(paths[0]))
        } else {
            register(
                ctx,
                &paths[0],
                false,
                json!(repo),
                paths
                    .iter()
                    .find(|p| gguf::is_projector(p))
                    .map(PathBuf::as_path),
            )
        }
    })();
    JOBS.lock().map_err(|e| e.to_string())?.remove(&id);
    let _ = app.emit("download-progress", json!({"id":id,"status":"reset"}));
    result
}
pub(super) fn handle(cmd: &str, a: &Value, ctx: &Ctx, app: &tauri::AppHandle) -> Reply {
    if cmd == "cancel_download" {
        let id = argument(a, "id")?;
        if id.starts_with("img:") || id == "sdengine" {
            crate::media::cancel_download(id);
            return Ok(Value::Null);
        }
        if let Some(f) = JOBS
            .lock()
            .map_err(|e| e.to_string())?
            .get(argument(a, "id")?)
        {
            f.store(true, Ordering::Relaxed)
        }
        return Ok(Value::Null);
    }
    let h = Hub::new(ctx)?;
    match cmd {
        "search_hf" => h.search(argument(a, "query")?),
        "repo_quants" => h.repo(argument(a, "repo")?)?.rows(ctx),
        _ => download(cmd, a, ctx, &h, app),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variants_and_projectors_do_not_merge_into_a_sharded_quant() {
        let mut siblings = vec![];
        for name in [
            "Q4/model-UD-Q4_K_XL-00002-of-00002.gguf",
            "Q4/model-UD-Q4_K_XL-00001-of-00002.gguf",
            "other/other-UD-Q4_K_XL.gguf",
            "mmproj-f16.gguf",
            "README.md",
        ] {
            siblings.push(json!({"rfilename":name,"size":50}));
        }
        let r = Repository::parse(&json!({"sha":"0".repeat(40),"siblings":siblings})).unwrap();
        assert_eq!(r.quants.len(), 2);
        assert_eq!(r.quants["UD-Q4_K_XL"].len(), 2);
        assert_eq!(total(&r.quants["UD-Q4_K_XL"]), 100);
        assert_eq!(r.projectors.len(), 1);
    }

    #[test]
    fn paused_download_resumes_at_saved_offset() {
        use std::{
            io::{BufRead, BufReader},
            net::TcpListener,
            thread,
        };
        let tmp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let ctx = Ctx::new(tmp.path().join("ctx")).unwrap();
        ctx.write(
            "settings",
            &json!({"custom_mirror":format!("http://{}",listener.local_addr().unwrap())}),
        )
        .unwrap();
        let h = Hub::new(&ctx).unwrap();
        let server = thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let _request = BufReader::new(&conn)
                .lines()
                .map(Result::unwrap)
                .take_while(|s| !s.is_empty())
                .collect::<Vec<_>>();
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n")
                .unwrap();
            thread::sleep(Duration::from_millis(260));
            conn.write_all(b"GGUF1234").unwrap();
            drop(conn);
            let (mut conn, _) = listener.accept().unwrap();
            let headers = BufReader::new(&conn)
                .lines()
                .map(Result::unwrap)
                .take_while(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(headers.to_ascii_lowercase().contains("range: bytes=8-"));
            conn.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 8-11/12\r\nContent-Length: 4\r\nConnection: close\r\n\r\n5678").unwrap();
        });
        let files = vec![json!({"name":"model.gguf","bytes":12})];
        let flag = AtomicBool::new(false);
        let first = transfer(
            &h,
            "a/b",
            "revision",
            &files,
            tmp.path(),
            "a/b:q",
            &flag,
            |_| flag.store(true, Ordering::Relaxed),
        );
        assert!(first.unwrap_err().contains("暂停"));
        assert!(!tmp.path().join("model.gguf").exists());
        flag.store(false, Ordering::Relaxed);
        let paths = transfer(
            &h,
            "a/b",
            "revision",
            &files,
            tmp.path(),
            "a/b:q",
            &flag,
            |_| (),
        )
        .unwrap();
        assert_eq!(fs::read(&paths[0]).unwrap(), b"GGUF12345678");
        server.join().unwrap();
    }

    #[test]
    fn completed_partial_with_incorrect_digest_is_discarded() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().join("ctx")).unwrap();
        let h = Hub::new(&ctx).unwrap();
        let part = tmp.path().join("model.gguf.revision.part");
        fs::write(&part, b"GGUFwrong").unwrap();
        let files = [json!({"name":"model.gguf","bytes":9,"sha256":"0".repeat(64)})];
        let error = transfer(
            &h,
            "a/b",
            "revision",
            &files,
            tmp.path(),
            "job",
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap_err();
        assert!(error.contains("SHA-256"));
        assert!(!part.exists());
        assert!(!tmp.path().join("model.gguf").exists());
    }

    #[test]
    #[ignore = "requires a Hugging Face endpoint; optionally set LOCMODEL_TEST_MIRROR"]
    fn public_repository_download_and_import() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().join("data")).unwrap();
        ctx.write(
            "settings",
            &json!({"custom_mirror":std::env::var("LOCMODEL_TEST_MIRROR").unwrap_or_default()}),
        )
        .unwrap();
        let h = Hub::new(&ctx).unwrap();
        let hits = h.search("tinyllama").unwrap();
        assert!(!hits.as_array().unwrap().is_empty());
        let repo = "ggml-org/models-moved";
        let r = h.repo(repo).unwrap();
        let file = r
            .quants
            .values()
            .flatten()
            .find(|f| f["name"] == "tinyllamas/stories260K.gguf")
            .unwrap()
            .clone();
        let files = transfer(
            &h,
            repo,
            &r.revision,
            &[file],
            tmp.path(),
            "test",
            &AtomicBool::new(false),
            |_| (),
        )
        .unwrap();
        let model = register(&ctx, &files[0], false, json!(repo), None).unwrap();
        assert_eq!(model["info"]["arch"], "llama");
        remove(&ctx, &json!({"path":model["path"],"deleteFiles":true})).unwrap();
        assert!(!files[0].exists());
    }
}
