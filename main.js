
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fss = require('fs');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const Store = require('electron-store');
const sharp = require('sharp');
const store = new Store();

const VAULT_FOLDER = 'onevault';
let mainWindow;
let isVaultUnlocked = false;

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800, 
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        backgroundColor: '#000000',
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

const encryptFile = async (sourcePath, targetPath, key) => {
    const iv = crypto.randomBytes(16);
    const salt = crypto.randomBytes(16);
    const derivedKey = await crypto.scryptSync(key, salt, 32);
    
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    const input = fss.createReadStream(sourcePath);
    const output = fss.createWriteStream(targetPath);
    
    output.write(Buffer.concat([iv, salt]));
    
    let authTag;
    cipher.on('end', () => {
        authTag = cipher.getAuthTag();
        output.write(authTag);
    });

    return new Promise((resolve, reject) => {
        input.pipe(cipher).pipe(output);
        output.on('finish', resolve);
        output.on('error', reject);
    });
};

const decryptFile = async (sourcePath, targetPath, key) => {
    return new Promise(async (resolve, reject) => {
        const fileBuffer = await fs.readFile(sourcePath);
        const iv = fileBuffer.slice(0, 16);
        const salt = fileBuffer.slice(16, 32);
        const authTag = fileBuffer.slice(-16);
        const encryptedData = fileBuffer.slice(32, -16);
        
        try {
            const derivedKey = await crypto.scryptSync(key, salt, 32);
            const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
            decipher.setAuthTag(authTag);
            
            const decrypted = Buffer.concat([
                decipher.update(encryptedData),
                decipher.final()
            ]);
            
            await fs.writeFile(targetPath, decrypted);
            resolve();
        } catch (error) {
            reject(error);
        }
    });
};
ipcMain.handle('get-drives', async () => {
    if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        const drives = execSync('wmic logicaldisk get caption')
            .toString()
            .split('\r\r\n')
            .filter((drive) => drive.trim().length > 0 && drive.trim() !== 'Caption')
            .map((drive) => drive.trim());
        return drives;
    }
    return ['/'];
});

ipcMain.handle('read-directory', async (event, dirPath) => {
    try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        return items.map((item) => ({
            name: item.name,
            isDirectory: item.isDirectory(),
            path: path.join(dirPath, item.name),
            isEncrypted: path.dirname(path.join(dirPath, item.name)).includes(VAULT_FOLDER)
        }));
    } catch (error) {
        console.error('Error reading directory:', error);
        return [];
    }
});

ipcMain.handle('open-file', async (event, filePath) => {
    try {
        const isVaultFile = path.dirname(filePath).includes(VAULT_FOLDER);
        
        if (isVaultFile) {
            if (!isVaultUnlocked) {
                throw new Error('Vault is locked');
            }
            
            const totpSecret = store.get('totpSecret');
            const tempPath = path.join(app.getPath('temp'), `temp_${path.basename(filePath)}`);
            await decryptFile(filePath, tempPath, totpSecret);
            
            await shell.openPath(tempPath);
            
            setTimeout(async () => {
                try {
                    await fs.unlink(tempPath);
                } catch (error) {
                    console.error('Error cleaning up temp file:', error);
                }
            }, 1000);
            
            return true;
        } else {
            await shell.openPath(filePath);
            return true;
        }
    } catch (error) {
        console.error('Error opening file:', error);
        return false;
    }
});

ipcMain.handle('copy-file', async (event, { sourcePath, targetDir, isVault }) => {
    try {
        const fileName = path.basename(sourcePath);
        let targetPath = path.join(targetDir, fileName);

        let counter = 1;
        while (fss.existsSync(targetPath)) {
            const ext = path.extname(fileName);
            const nameWithoutExt = path.basename(fileName, ext);
            targetPath = path.join(targetDir, `${nameWithoutExt} (${counter})${ext}`);
            counter++;
        }

        if (isVault) {
            if (!isVaultUnlocked) {
                throw new Error('Vault is locked');
            }
            const totpSecret = store.get('totpSecret');
            await encryptFile(sourcePath, targetPath, totpSecret);
        } else {
            await fs.copyFile(sourcePath, targetPath);
        }

        return { success: true };
    } catch (error) {
        console.error('Error copying file:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('delete-item', async (event, itemPath) => {
    try {
        const stats = await fs.stat(itemPath);
        if (stats.isDirectory()) {
            await fs.rmdir(itemPath, { recursive: true });
        } else {
            await fs.unlink(itemPath);
        }
        return true;
    } catch (error) {
        console.error('Error deleting item:', error);
        return false;
    }
});

ipcMain.handle('generate-thumbnail', async (event, filePath) => {
    try {
        const isVaultFile = path.dirname(filePath).includes(VAULT_FOLDER);
        if (isVaultFile && !isVaultUnlocked) {
            return null;
        }

        const ext = path.extname(filePath).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

        if (imageExts.includes(ext)) {
            if (isVaultFile) {
                const totpSecret = store.get('totpSecret');
                const tempPath = path.join(app.getPath('temp'), `temp_thumb_${path.basename(filePath)}`);
                await decryptFile(filePath, tempPath, totpSecret);
                
                const thumbnail = await sharp(tempPath)
                    .resize(200, 200, {
                        fit: 'contain',
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    })
                    .toBuffer();
                
                await fs.unlink(tempPath);
                return `data:image/${ext.slice(1)};base64,${thumbnail.toString('base64')}`;
            } else {
                const thumbnail = await sharp(filePath)
                    .resize(200, 200, {
                        fit: 'contain',
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    })
                    .toBuffer();
                return `data:image/${ext.slice(1)};base64,${thumbnail.toString('base64')}`;
            }
        }
        return null;
    } catch (error) {
        console.error('Error generating thumbnail:', error);
        return null;
    }
});
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
        issuer: 'OneStore',
    });
    store.set('totpSecret', secret.base32);
    return {
        secret: secret.base32,
        otpauth_url: secret.otpauth_url,
    };
});

ipcMain.handle('verify-initial-totp', async (event, token) => {
    const secret = store.get('totpSecret');
    const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token,
    });

    if (verified) {
        store.set('totpSetup', true);
        isVaultUnlocked = true;
        return true;
    }
    return false;
});

ipcMain.handle('verify-totp', async (event, token) => {
    const secret = store.get('totpSecret');
    const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token,
    });
    
    if (verified) {
        isVaultUnlocked = true;
    }
    return verified;
});

ipcMain.on('reset-totp', () => {
    store.delete('totpSetup');
    store.delete('totpSecret');
    isVaultUnlocked = false;
    mainWindow.loadFile('welcome.html');
});

ipcMain.on('lock-vault', () => {
    isVaultUnlocked = false;
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
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

const fileItemTemplate = (item, thumbnail) => `
    <div class="file-item ${item.isEncrypted ? 'encrypted' : ''}" 
         data-path="${item.path}"  
         onclick="handleItemClick(event, '${item.path}', ${item.isDirectory})">
        <div class="file-actions">
            <button class="action-button" onclick="deleteItem('${item.path}')">
                <span class="material-icons">delete</span>
            </button>
        </div>
        <div class="file-icon">
            ${item.isDirectory ? '📁' : (thumbnail || getDefaultIcon(item.path))}
        </div>
        <div class="file-name">
            ${item.name}
            ${item.isEncrypted ? '<span class="material-icons">lock</span>' : ''}
        </div>
    </div>
`;