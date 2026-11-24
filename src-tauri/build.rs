fn main() {
    // tauri_build 把窗口图标编进 Windows 资源，却没有把这个文件登记为构建脚本的输入：
    // 只替换 icons/icon.ico 时资源不会重新编译，换图标后 exe 里还是旧的。这里自己登记一下
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
