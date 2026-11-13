@echo off
rem Publish the faces in data\ (your local Kaggle batch) to the live GitHub Pages site.
rem Run from the repo folder:  push-faces.cmd
cd /d "%~dp0"
if exist pool rmdir /s /q pool
git clone --depth 1 --branch pool https://github.com/oswaldamoah/thisafricandoesnotexist.git pool || goto :err
node tools\seed-pool.mjs data pool || goto :err
pushd pool
git add -A
git commit -m "seed pool with local Kaggle faces" || (popd & goto :err)
git push origin HEAD:pool || (popd & goto :err)
popd
rem pushing main starts the workflow, which rebuilds the site from the pool branch
git add public/index.html tools/seed-pool.mjs push-faces.cmd
git commit -m "Seed Pages pool from local faces; skip /api on GitHub Pages"
git push || goto :err
echo.
echo Done. The site redeploys in ~2 minutes: https://github.com/oswaldamoah/thisafricandoesnotexist/actions
exit /b 0
:err
echo FAILED - see the message above.
exit /b 1
