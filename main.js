const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fss = require('fs');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const Store = require('electron-store');
const store = new Store();

let mainWindow;

store.delete('totpSetup');
store.delete('totpSecret');
async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#000000'
    });

    await mainWindow.loadFile('index.html');

    setTimeout(async () => {
        if (!store.get('totpSetup')) {
            await mainWindow.loadFile('welcome.html');
        } else {
            await mainWindow.loadFile('home.html');
        }
    }, 2000);
}

ipcMain.handle('upload-file', async (event, { filePath, targetDir, isVault }) => {
    try {
        const fileName = path.basename(filePath);
        let targetPath = path.join(targetDir, fileName);
        
        let counter = 1;
        while (fss.existsSync(targetPath)) {
            const ext = path.extname(fileName);
            const nameWithoutExt = path.basename(fileName, ext);
            targetPath = path.join(targetDir, `${nameWithoutExt} (${counter})${ext}`);
            counter++;
        }

        if (isVault) {
            await encryptFile(filePath, targetPath);
        } else {
            await fs.copyFile(filePath, targetPath);
        }
        
        return { success: true };
    } catch (error) {
        console.error('Upload error:', error);
        return { success: false, error: error.message };
    }
});

async function encryptFile(sourcePath, targetPath) {
    return new Promise((resolve, reject) => {
        try {
            const key = crypto.scryptSync(store.get('totpSecret'), 'salt', 32);
            const iv = crypto.randomBytes(16);

            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            const input = fss.createReadStream(sourcePath);
            const output = fss.createWriteStream(targetPath);

            output.write(iv);

            input.pipe(cipher).pipe(output);

            output.on('finish', resolve);
            output.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}
async function decryptFile(sourcePath, targetPath) {
    return new Promise((resolve, reject) => {
        try {
            const key = crypto.scryptSync(store.get('totpSecret'), 'salt', 32);
            const input = fss.createReadStream(sourcePath);
            const output = fss.createWriteStream(targetPath);
            const chunks = [];
            input.once('readable', () => {
                let chunk;
                while (null !== (chunk = input.read(16))) {
                    chunks.push(chunk);
                    break;
                }
                const iv = Buffer.concat(chunks);

                const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
                input.pipe(decipher).pipe(output);
            });

            output.on('finish', resolve);
            output.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}

ipcMain.handle('get-drives', async () => {
    if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        const drives = execSync('wmic logicaldisk get caption').toString().split('\r\r\n')
            .filter(drive => drive.trim().length > 0 && drive.trim() !== 'Caption')
            .map(drive => drive.trim());
        return drives;
    }
    return ['/'];
});

ipcMain.handle('read-directory', async (event, dirPath) => {
    try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        return items.map(item => ({
            name: item.name,
            isDirectory: item.isDirectory(),
            path: path.join(dirPath, item.name)
        }));
    } catch (error) {
        console.error('Error reading directory:', error);
        return [];
    }
});

ipcMain.handle('open-file', async (event, filePath) => {
    try {
        if (filePath.includes(VAULT_FOLDER)) {
            const tempPath = path.join(app.getPath('temp'), path.basename(filePath));
            await decryptFile(filePath, tempPath);
            await shell.openPath(tempPath);
            setTimeout(() => {
                fs.unlink(tempPath).catch(console.error);
            }, 1000);
        } else {
            await shell.openPath(filePath);
        }
        return true;
    } catch (error) {
        console.error('Error opening file:', error);
        return false;
    }
});
const VAULT_FOLDER = 'onevault';

ipcMain.handle('get-vault-directory', async (event, currentPath) => {
    const vaultPath = path.join(currentPath, VAULT_FOLDER);
    try {
        await fs.mkdir(vaultPath, { recursive: true });
        return vaultPath;
    } catch (error) {
        console.error('Error creating vault directory:', error);
        return null;
    }
});

ipcMain.handle('generate-totp-secret', async () => {
    const secret = speakeasy.generateSecret({
        name: 'OneStore:Vault',
        issuer: 'OneStore'
    });
    store.set('totpSecret', secret.base32);
    return {
        secret: secret.base32,
        otpauth_url: secret.otpauth_url
    };
});

ipcMain.handle('verify-initial-totp', async (event, token) => {
    const secret = store.get('totpSecret');
    const verified = speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: token
    });
    
    if (verified) {
        store.set('totpSetup', true);
        return true;
    }
    return false;
});

ipcMain.handle('verify-totp', async (event, token) => {
    const secret = store.get('totpSecret');
    return speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: token
    });
});

ipcMain.on('reset-totp', () => {
    store.delete('totpSetup');
    store.delete('totpSecret');
    mainWindow.loadFile('welcome.html');
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
