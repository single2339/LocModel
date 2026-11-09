// Exercises the production WebView and IPC dispatcher on the desktop main thread.
use std::{
    env,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Listener, Manager};
#[path = "support/account_mock.rs"]
mod account_mock;

fn main() {
    let dir = tempfile::tempdir().unwrap();
    env::set_var("LOCMODEL_DATA_DIR", dir.path());
    let settings = serde_json::json!({"account_base": account_mock::start()});
    std::fs::write(dir.path().join("settings.json"), settings.to_string()).unwrap();
    let app = locmodel::builder()
        .build(tauri::generate_context!())
        .unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let handle = app.handle().clone();
    let finished = done.clone();
    app.listen("desktop-test-result", move |event| {
        println!("{}", event.payload());
        let result: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        finished.store(true, Ordering::Release);
        handle.exit(if result["ok"] == true { 0 } else { 1 });
    });
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let Some(win) = (0..200).find_map(|_| {
            std::thread::sleep(Duration::from_millis(50));
            handle.get_webview_window("main")
        }) else {
            eprintln!("No main window");
            handle.exit(1);
            return;
        };
        for _ in 0..45 {
            if done.load(Ordering::Acquire) {
                return;
            }
            let fixture = serde_json::to_string(&env::var("LOCMODEL_TEST_GGUF").ok()).unwrap();
            let js = include_str!("desktop.js").replace("__MODEL_FIXTURE__", &fixture);
            win.eval(&js).unwrap();
            std::thread::sleep(Duration::from_secs(2));
        }
        eprintln!("Timed out waiting for the desktop frontend");
        handle.exit(1);
    });
    let status = app.run_return(|_, e| {
        if matches!(e, tauri::RunEvent::Exit) {
            locmodel::shutdown()
        }
    });
    drop(dir);
    std::process::exit(status);
}
