import sys
import json
import subprocess
import re
import os
import traceback
from pathlib import Path

def main():
    try:
        # 1. รับค่า Arguments ทั้งหมดที่ส่งมาจาก VS Code
        target_args = sys.argv[1:]
        
        # ค้นหา Python ที่กำลังรันอยู่ (ตัวที่อยู่ใน .venv)
        python_exe = sys.executable
        bin_dir = os.path.dirname(python_exe)
        
        # ค้นหาคำสั่ง pygreensense ในโฟลเดอร์ .venv/bin (หรือ Scripts ใน Windows)
        cli_exe = os.path.join(bin_dir, "pygreensense")
        if os.name == 'nt':
            cli_exe += ".exe"
            
        # 2. ประกอบคำสั่ง cmd ใหม่ด้วยการใช้ List Concatenation (+)
        if os.path.exists(cli_exe):
            cmd = [cli_exe] + target_args
        else:
            cmd = [python_exe, "-m", "green_code_smell.cli"] + target_args
            
        # 3. รันโปรเซสและจับข้อความ Output
        process = subprocess.run(cmd, capture_output=True, text=True)
        stdout_text = process.stdout
        
        # 4. แกะรอย Code Smells จาก Text Output
        issues = []
        current_rule = "Unknown"
        
        for line in stdout_text.splitlines():
            line = line.strip()
            # ตรวจจับหัวข้อ Rule เช่น "DeadCode (6 issue(s)):"
            if "issue(s)):" in line:
                parts = line.split()
                if len(parts) > 0:
                    current_rule = parts[0] # แก้ไขบั๊ก .strip() ตรงนี้แล้ว
            # ตรวจจับบรรทัดที่บอก Error เช่น "Line 9: Unused variable..."
            elif line.startswith("Line "):
                match = re.match(r"Line (\d+):\s*(.*)", line)
                if match:
                    issues.append({
                        "rule": current_rule,
                        "lineno": int(match.group(1)),
                        "message": match.group(2),
                        "severity": "Warning"
                    })
                    
        # 5. อ่านข้อมูล Metrics ขั้นสูงจาก history.json
        history_path = Path(__file__).parent / "history.json"
        latest_metrics = {}
        
        if history_path.exists():
            with open(history_path, 'r', encoding='utf-8') as f:
                try:
                    history_data = json.load(f)
                    if isinstance(history_data, list) and len(history_data) > 0:
                        latest_metrics = history_data[-1]  # ดึงข้อมูลรอบล่าสุดที่เพิ่งรันเสร็จ
                except Exception:
                    pass

        # 6. ประกอบร่าง JSON ส่งกลับไปให้ extension.ts
        response = {
            "status": "success",
            "data": {
                "issues": issues,
                "metrics": latest_metrics
            }
        }
        print(json.dumps(response, indent=2))

    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        error_res = {
            "status": "error",
            "message": str(e)
        }
        print(json.dumps(error_res))
        sys.exit(1)

if __name__ == "__main__":
    main()