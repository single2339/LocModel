#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    locmodel::builder()
        .build(tauri::generate_context!())
        .expect("无法初始化 LocModel")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                locmodel::shutdown();
            }
        })
}
