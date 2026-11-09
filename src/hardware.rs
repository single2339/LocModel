use crate::{engine, Ctx, Reply};
use serde_json::{json, Value};
use std::{
    process::Command,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use sysinfo::{Disks, Pid, ProcessesToUpdate, System};

static SYS: LazyLock<Mutex<System>> = LazyLock::new(|| Mutex::new(System::new()));
static GPU_SAMPLE: Mutex<Option<(Instant, Vec<Value>)>> = Mutex::new(None);
const GIB: u64 = 1 << 30;

#[cfg(target_os = "macos")]
fn sample() -> Vec<Value> {
    use objc2::rc::Retained;
    use objc2_metal::{MTLCreateSystemDefaultDevice, MTLDevice};
    // Metal's Create function returns a retained object or nil on unsupported hardware.
    let Some(device) = (unsafe { Retained::from_raw(MTLCreateSystemDefaultDevice()) }) else {
        return vec![];
    };
    let name = device.name().to_string();
    let shared = device.hasUnifiedMemory();
    let total = device.recommendedMaxWorkingSetSize();
    let mut gpu = json!({"name":name,"vendor":if name.starts_with("Apple"){"apple"}else if name.contains("AMD"){"amd"}else{"intel"},"integrated":shared,"shared":shared,"backend":"metal","vram_bytes":total});
    if let Some(nodes) = Command::new("/usr/sbin/ioreg")
        .args(["-r", "-c", "IOAccelerator", "-d", "1", "-a"])
        .output()
        .ok()
        .and_then(|o| plist::Value::from_reader_xml(&o.stdout[..]).ok())
    {
        if let Some(stats) = nodes
            .as_array()
            .iter()
            .flat_map(|n| n.iter())
            .filter_map(|n| n.as_dictionary())
            .find(|node| node.get("model").and_then(|m| m.as_string()) == Some(name.as_str()))
            .and_then(|node| node.get("PerformanceStatistics"))
            .and_then(|s| s.as_dictionary())
        {
            let counter = |key: &str| stats.get(key).and_then(plist::Value::as_unsigned_integer);
            gpu["vram_used_bytes"] = json!(counter(if shared {
                "In use system memory"
            } else {
                "vramUsedBytes"
            }));
            gpu["util"] = json!(counter("Device Utilization %"));
        }
    }
    vec![gpu]
}

#[cfg(any(not(target_os = "macos"), test))]
fn nvidia_rows(csv: &str) -> Vec<Value> {
    csv.lines().filter_map(|row|{
        let fields:Vec<_>=row.split(',').map(str::trim).collect();
        if fields.len()!=8{return None;}
        let mib=|i:usize|fields[i].parse::<u64>().ok().and_then(|v|v.checked_mul(1<<20));
        let number=|i:usize|fields[i].parse::<f64>().ok().filter(|v|v.is_finite());
        Some(json!({"name":fields[0],"vendor":"nvidia","driver":fields[1],"integrated":false,"shared":false,"backend":"cuda",
        "vram_bytes":mib(2),"vram_used_bytes":mib(3),"util":number(4),"temp":number(5),"power":number(6),"power_limit":number(7)}))
    }).collect()
}
#[cfg(windows)]
fn win_probe() -> Value {
    // The CIM/registry probe also works on devices without NVIDIA's utility.
    static PROBE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
    let mut cached = PROBE.lock().unwrap();
    if let Some((at, data)) = &*cached {
        if at.elapsed() < Duration::from_secs(30) {
            return data.clone();
        }
    }
    use std::os::windows::process::CommandExt;
    let result = Command::new("powershell.exe")
        .creation_flags(0x08000000)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("../assets/hardware-probe.ps1"),
        ])
        .output()
        .ok()
        .and_then(|o| {
            serde_json::from_str::<Value>(
                String::from_utf8_lossy(&o.stdout).trim_start_matches('\u{feff}'),
            )
            .ok()
        })
        .unwrap_or(Value::Null);
    *cached = Some((Instant::now(), result.clone()));
    result
}
#[cfg(not(target_os = "macos"))]
fn sample() -> Vec<Value> {
    let mut cmd = Command::new("nvidia-smi");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let gpus=cmd.args(["--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit","--format=csv,noheader,nounits"]).output().ok().filter(|o|o.status.success())
        .map(|o|nvidia_rows(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default();
    #[cfg(windows)]
    {
        let mut gpus = gpus;
        for row in win_probe()["adapters"].as_array().into_iter().flatten() {
            let name = row["name"].as_str().unwrap_or("");
            if name.is_empty()
                || gpus.iter().any(|g| {
                    g["name"]
                        .as_str()
                        .is_some_and(|n| n.eq_ignore_ascii_case(name))
                })
            {
                continue;
            }
            let text = name.to_lowercase();
            if text.contains("microsoft basic") || text.contains("remote display") {
                continue;
            }
            let vendor = if text.contains("nvidia") {
                "nvidia"
            } else if text.contains("intel") {
                "intel"
            } else if text.contains("radeon") || text.contains("amd") {
                "amd"
            } else {
                "unknown"
            };
            let integrated = (vendor == "intel" && !text.contains(" arc"))
                || text.contains("radeon(tm) graphics");
            gpus.push(json!({"name":name,"vendor":vendor,"driver":row["driver"],"vram_bytes":row["vram"],"integrated":integrated,"shared":integrated,"backend":"vulkan"}));
        }
        gpus
    }
    #[cfg(not(windows))]
    {
        gpus
    }
}
fn measured() -> Vec<Value> {
    let mut cached = GPU_SAMPLE.lock().unwrap();
    if let Some((at, gpus)) = &*cached {
        if at.elapsed() < Duration::from_secs(1) {
            return gpus.clone();
        }
    }
    let mut gpus = sample();
    gpus.sort_by_key(|g| {
        std::cmp::Reverse((
            !g["integrated"].as_bool().unwrap_or(false),
            g["vram_bytes"].as_u64().unwrap_or(0),
        ))
    });
    *cached = Some((Instant::now(), gpus.clone()));
    gpus
}
fn configured(ctx: &Ctx) -> Result<Vec<Value>, String> {
    let settings = ctx.settings()?;
    let o = &settings["gpu_override"];
    if let Some(gb) = o["vram_gb"].as_f64().filter(|v| *v > 0.) {
        let vendor = o["vendor"].as_str().unwrap_or("unknown");
        return Ok(vec![
            json!({"name":o["name"].as_str().filter(|s|!s.is_empty()).unwrap_or(vendor),"vendor":vendor,"integrated":false,"shared":false,"backend":if vendor=="nvidia"{"cuda"}else{"vulkan"},"vram_bytes":(gb*GIB as f64) as u64}),
        ]);
    }
    Ok(measured())
}
pub fn available_ram(sys: &System) -> u64 {
    // sysinfo 0.37 subtracts compressed pages again from available pages on macOS.
    // Use the complement of its resident used-memory estimate on this platform.
    #[cfg(target_os = "macos")]
    {
        sys.total_memory().saturating_sub(sys.used_memory())
    }
    #[cfg(not(target_os = "macos"))]
    {
        sys.available_memory()
    }
}
pub fn capacity_gpu(ctx: &Ctx) -> u64 {
    let Ok(gpus) = configured(ctx) else {
        return 0;
    };
    let Some(g) = gpus.first() else {
        return 0;
    };
    let free = g["vram_bytes"]
        .as_u64()
        .unwrap_or(0)
        .saturating_sub(g["vram_used_bytes"].as_u64().unwrap_or(0));
    if g["shared"] == true {
        let mut s = SYS.lock().unwrap();
        s.refresh_memory();
        free.min(available_ram(&s))
    } else {
        free
    }
}
pub fn gpu_memory_is_shared(ctx: &Ctx) -> bool {
    configured(ctx)
        .ok()
        .and_then(|v| v.first().and_then(|g| g["shared"].as_bool()))
        .unwrap_or(false)
}
pub fn overview(ctx: &Ctx) -> Reply {
    let g = configured(ctx)?;
    let backend = g
        .first()
        .and_then(|g| g["backend"].as_str())
        .unwrap_or("cpu");
    let mut s = SYS.lock().unwrap();
    s.refresh_memory();
    s.refresh_cpu_all();
    let cpu = json!({"name":s.cpus().first().map(|c|c.brand()).unwrap_or("CPU"),"logical_cores":s.cpus().len(),"physical_cores":System::physical_core_count().unwrap_or(s.cpus().len())});
    let kind = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "统一内存"
    } else {
        ""
    };
    #[cfg(windows)]
    let kind = match win_probe()["memType"].as_u64() {
        Some(24) => "DDR3",
        Some(26) => "DDR4",
        Some(30) => "LPDDR4",
        Some(34) => "DDR5",
        Some(35) => "LPDDR5",
        _ => kind,
    };
    let memory =
        json!({"available_bytes":available_ram(&s),"total_bytes":s.total_memory(),"kind":kind});
    drop(s);
    let disks:Vec<_>=Disks::new_with_refreshed_list().iter().map(|d|json!({"mount":d.mount_point(),"available_bytes":d.available_space(),"total_bytes":d.total_space(),"is_ssd":d.kind()==sysinfo::DiskKind::SSD})).collect();
    let h = json!({"cpu":cpu,"memory":memory,"gpus":g,"primary_gpu":if g.is_empty(){None}else{Some(0)},"backend":backend,"disks":disks});
    Ok(
        json!({"hardware":h,"models_dir":ctx.settings()?["models_dir"],"recs":crate::models::catalog(ctx)?,"engine":engine::info(ctx),"conclusion":{"headline":"本机模型工作台","detail":"选择推荐模型，或导入已有的 GGUF 文件。"}}),
    )
}
pub fn monitor() -> Value {
    let mut gpus = measured();
    for g in &mut gpus {
        g["vram_total"] = g["vram_bytes"].clone();
        g["vram_used"] = g["vram_used_bytes"].clone();
    }
    let ids: Vec<Pid> = [engine::pid(), crate::media::pid()]
        .into_iter()
        .flatten()
        .map(Pid::from_u32)
        .collect();
    let mut s = SYS.lock().unwrap();
    s.refresh_memory();
    s.refresh_cpu_all();
    s.refresh_processes(ProcessesToUpdate::Some(&ids), true);
    let cores = s.cpus().len();
    let procs:Vec<_>=ids.iter().filter_map(|id|s.process(*id)).map(|p|json!({"name":p.name().to_string_lossy(),"pid":p.pid().as_u32(),"cpu":p.cpu_usage()/cores.max(1) as f32,"mem":p.memory()})).collect();
    let first = gpus.first();
    json!({"cores":cores,"cpu_name":s.cpus().first().map(|c|c.brand()),"cpu":s.global_cpu_usage(),"gpus":gpus,"procs":procs,"mem_used":s.used_memory(),"mem_total":s.total_memory(),"ram_used":s.used_memory(),"ram_total":s.total_memory(),"vram_used":first.map(|g|&g["vram_used"]),"vram_total":first.map(|g|&g["vram_total"])})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nvidia_converts_mib_and_leaves_missing_sensors_null() {
        let rows = nvidia_rows("NVIDIA GeForce RTX 4060, 580.2, 8192, 620, 75, 60, 93.5, [N/A]");
        assert_eq!(rows[0]["vram_bytes"], 8 * GIB);
        assert_eq!(rows[0]["power"], 93.5);
        assert!(rows[0]["power_limit"].is_null());
    }
}
