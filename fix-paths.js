const db = require('./db');
try {
    const result = db.prepare("UPDATE files SET file_path = REPLACE(file_path, '\\', '/')").run();
    console.log(`✅ Fixed ${result.changes} file paths to use forward slashes.`);
} catch (e) {
    console.error("❌ Error fixing paths:", e.message);
}