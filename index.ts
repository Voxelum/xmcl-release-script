import { cmd } from '7zip-min'
import { Octokit } from '@octokit/rest'
import { spawnSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'

const api = new Octokit({
    auth: process.env.GITHUB_PAT,
})

const unpackExe = (zip: string, file: string, dir: string) => {
    console.log(`Unpack ${file} in ${zip} in ${dir}`)
    return new Promise<void>((resolve, reject) => {
        cmd(['e', zip, file, `-o${dir}`], (err) => {
            if (err) { reject(err) } else { resolve() }
        })
    })
}
const updateExe = (zip: string, file: string) => {
    console.log(`Update ${file} to zip ${file}`)
    return new Promise<void>((resolve, reject) => {
        cmd(['u', zip, file], (err) => {
            if (err) { reject(err) } else { resolve() }
        })
    })
}

async function main(releaseId: number, assetId: number) {
    releaseId = 61085595
    console.log(`Release id: ${releaseId}. Asset id: ${assetId}`)

    // await api.repos.updateRelease({ owner: 'voxelum', repo: 'x-minecraft-launcher', release_id: releaseId, draft: true })
    // return

    const toSigned = [] as string[]
    let signDone = () => { }
    let startSign = () => { }
    const signPromise = new Promise<void>((resolve) => {
        signDone = resolve
    })
    const startSignPromise = new Promise<void>((resolve) => {
        startSign = resolve
    })
    let startSignSemaphore = 0
    async function semaphore(func: () => Promise<void>): Promise<void> {
        startSignSemaphore += 1
        try {
            await func()
        } finally {
            startSignSemaphore -= 1
            console.log(`Remain semaphore ${startSignSemaphore}.`)
            if (startSignSemaphore === 0) {
                startSign()
            }
        }
    }

    const download = async (id: number, filePath: string) => {
        console.log(`Start to download the asset ${filePath}`)
        const downloadStart = Date.now()
        const { data } = await api.repos.getReleaseAsset({
            owner: 'voxelum', repo: 'x-minecraft-launcher', asset_id: id, headers: {
                'accept': 'application/octet-stream'
            }
        })
        await writeFile(filePath, Buffer.from(data as any))
        console.log(`Downloaded ${filePath} (${(statSync(filePath).size / 1024 / 1024).toFixed(2)}MB) asset. Took ${(Date.now() - downloadStart) / 1000}s.`)
    }

    const upload = async (name: string, content: Buffer) => {
        console.log(`Start to upload the signed asset!`)
        const uploadStart = Date.now()
        const uploadResult = await api.repos.uploadReleaseAsset({ owner: 'voxelum', repo: 'x-minecraft-launcher', release_id: releaseId, name, data: content as any })
        console.log(`Upload the asset ${uploadResult.status}! ${uploadResult.data.id}. Took ${(Date.now() - uploadStart) / 1000}s`)
    }

    const deleteAsset = async (id: number) => {
        const uploadResult = await api.repos.deleteReleaseAsset({ owner: 'voxelum', repo: 'x-minecraft-launcher', release_id: releaseId, asset_id: id })
        console.log(`Delete asset ${id}: ${uploadResult.status}`)
    }

    const release = await api.repos.getRelease({ owner: 'voxelum', repo: 'x-minecraft-launcher', release_id: releaseId })
    const processAppX = async () => {
        const asset = release.data.assets.find(a => a.name.endsWith('-unsigned.appx'))

        const assetName = asset.name
        const appxFilePath = resolve(assetName)

        await semaphore(async () => {
            // download file
            await download(asset.id, appxFilePath)
            toSigned.push(appxFilePath)
        })

        await signPromise

        const signedAppxContent = await readFile(appxFilePath)
        // upload the new one
        await upload(assetName.replace('-unsigned', ''), signedAppxContent)
    }

    const processZip64 = async () => {
        const assets = release.data.assets
        const x64Zip = assets.find(a => a.name.endsWith('win32-x64-unsigned.zip'))
        const zipPath = resolve(x64Zip.name)
        const exePath = resolve('./x64/xmcl.exe')

        await semaphore(async () => {
            if (x64Zip) {
                await download(x64Zip.id, zipPath)
                await unpackExe(zipPath, 'xmcl.exe', 'x64')
                toSigned.push(exePath)
            }
        })
        await signPromise

        if (x64Zip) {
            await updateExe(zipPath, exePath)
            await upload(x64Zip.name.replace('-unsigned', ''), await readFile(zipPath))
        }

    }
    const processZip32 = async () => {
        const assets = release.data.assets
        const x32Zip = assets.find(a => a.name.endsWith('win32-ia32-unsigned.zip'))
        const zipPath = resolve(x32Zip.name)
        const exePath = resolve('./x32/xmcl.exe')

        await semaphore(async () => {
            if (x32Zip) {
                await download(x32Zip.id, zipPath)
                await unpackExe(zipPath, 'xmcl.exe', 'x32')
                toSigned.push(exePath)
            }
        })

        await signPromise

        if (x32Zip) {
            await updateExe(zipPath, exePath)
            await upload(x32Zip.name.replace('-unsigned', ''), await readFile(zipPath))
        }
    }

    const tasks = Promise.all([processAppX(), processZip32(), processZip64()])

    await startSignPromise

    // get the sign tool
    const windowsKitsPath = "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\"
    const dir = readdirSync(windowsKitsPath)
        .filter(f => f.startsWith('10.0'))
        .map(f => join(windowsKitsPath, f))
        .filter(f => statSync(f).isDirectory())
        .sort().reverse()[0]
    const signToolPath = join(dir, 'x64', 'signtool.exe')
    const args = [
        'sign',
        '/sha1',
        'e8ccca955b2685ec89937a933d1b314935bb8297',
        '/fd',
        'SHA256',
        '/n',
        'Open Source Developer, Hongze Xu',
        '/tr',
        'http://time.certum.pl',
        '/td',
        'SHA256',
        '/v',
        ...toSigned,
    ]

    console.log(`Sign with command: "${signToolPath}" ${args.join(' ')}`)

    // sign the app
    const result = spawnSync(signToolPath, args)

    console.log()
    for (const line of result.output.filter(l => !!l)) {
        console.log(line.toString())
    }

    signDone()

    await tasks
}

main(Number(process.argv[2]), Number(process.argv[3]))
