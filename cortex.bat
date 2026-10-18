@echo off
setlocal
:: التأكد من أننا في المجلد الصحيح
cd /d "%~dp0"
:: تشغيل الكود باستخدام node
node cli.js %*