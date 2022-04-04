import { Octokit } from '@octokit/rest'
import { spawnSync } from 'child_process'
import { readdirSync, readFileSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { unpack, cmd } from '7zip-min'

const api = new Octokit({
    auth: process.env.GITHUB_PAT,
})

const unpackExe = (zip: string, file: string) => {
    return new Promise<void>((resolve, reject) => {
        cmd(['e', zip, file], (err) => {
            if (err) { reject(err) } else { resolve() }
        })
    })
}
const updateExe = (zip: string, file: string) => {
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
    let _resolve = () => { }
    let _reject = () => { }
    const signPromise = new Promise<void>((resolve, reject) => {
        _resolve = resolve
        _reject = reject
    })
    let startSignSemaphore = 0
    async function semaphore(func: () => Promise<void>): Promise<void> {
        startSignSemaphore += 1
        try {
            await func()
        } finally {
            startSignSemaphore -= 1
        }
    }

    const downloadAppX = async () => {
        // get asset
        const asset = await api.repos.getReleaseAsset({
            owner: 'voxelum', repo: 'x-minecraft-launcher', asset_id: assetId
        })

        const assetName = asset.data.name
        const appxFilePath = resolve(assetName)

        await semaphore(async () => {
            // download file
            console.log(`Start to download the asset ${assetName}`)
            const downloadStart = Date.now()
            const { data } = await api.repos.getReleaseAsset({
                owner: 'voxelum', repo: 'x-minecraft-launcher', asset_id: assetId, headers: {
                    'accept': 'application/octet-stream'
                }
            })
            await writeFile(appxFilePath, Buffer.from(data as any))
            toSigned.push(appxFilePath)
            console.log(`Downloaded ${appxFilePath} (${(statSync(appxFilePath).size / 1024 / 1024).toFixed(2)}MB) asset. Took ${(Date.now() - downloadStart) / 1000}s.`)
        })

        await signPromise

        const signedAppxContent = readFileSync(appxFilePath)
        // upload the new one
        console.log(`Start to upload the signed asset!`)
        const uploadStart = Date.now()
        const uploadResult = await api.repos.uploadReleaseAsset({ owner: 'voxelum', repo: 'x-minecraft-launcher', release_id: releaseId, name: assetName.replace('-unsigned', '').replace('-x64', ''), data: signedAppxContent as any })
        console.log(`Upload the asset succeed! ${uploadResult.data.id}. Took ${(Date.now() - uploadStart) / 1000}s`)

        console.log(uploadResult.data)
    }

    const downloadZips = async () => {
        const release = await api.repos.getRelease({ owner: 'voxelum', repo: 'x-minecraft-launcher', release_id: releaseId })
        const assets = release.data.assets
        const x64Zip = assets.find(a => a.name.endsWith('win32-x64.zip'))
        const x32Zip = assets.find(a => a.name.endsWith('win32-ia32.zip'))
        if (x64Zip) {
            const zipPath = resolve(x64Zip.name)
            const { data } = await api.repos.getReleaseAsset({
                owner: 'voxelum', repo: 'x-minecraft-launcher', asset_id: x64Zip.id, headers: {
                    'accept': 'application/octet-stream'
                }
            })
            await writeFile(zipPath, Buffer.from(data as any))
            await unpackExe(zipPath, 'xmcl.exe')
            toSigned.push(resolve('xmcl.exe'))
        }
        if (x32Zip) {
            const zipPath = resolve(x32Zip.name)
            const { data } = await api.repos.getReleaseAsset({
                owner: 'voxelum', repo: 'x-minecraft-launcher', asset_id: x32Zip.id, headers: {
                    'accept': 'application/octet-stream'
                }
            })
            await writeFile(zipPath, Buffer.from(data as any))
            await unpackExe(zipPath, 'xmcl.exe')
            toSigned.push(resolve('xmcl.exe'))
        }

        await signPromise
    }

    await Promise.all([downloadAppX(), downloadZips()])

    const processSign = async () => {
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
        for (const line of result.output) {
            if (line) {
                console.log(line.toString())
            }
        }
    }
}

main(Number(process.argv[2]), Number(process.argv[3]))
