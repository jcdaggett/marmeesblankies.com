@echo off
cd /d "C:\Users\jesse\OneDrive\Desktop\Marmees Blankies\site"
echo Syncing with GitHub...
git pull --no-rebase --no-edit
git add -A
git commit -m "update"
git push
echo.
echo Deploy complete!
pause
