import { Octokit } from '@octokit/rest'
import { spawnSync } from 'child_process'
import { createWriteStream, readdirSync, readFileSync, statSync } from 'fs'
import fetch from 'node-fetch'
import { join, resolve } from 'path'
import { pipeline } from 'stream'

async function main(releaseId: number, assetId: number) {
    console.log(`Release id: ${releaseId}. Asset id: ${assetId}`)

    const api = new Octokit({
        auth: process.env.GITHUB_PAT,
    })

    // get asset
    const asset = await api.repos.getReleaseAsset({ owner: 'voxelum', repo: 'x-minecraft-launcher', asset_id: assetId })
    console.log(asset)

    const assetName = asset.data.name
    const appxFilePath = resolve(assetName)
    const url = asset.data.browser_download_url

    // download file
    console.log(`Start to download the asset`)
    const downloadStart = Date.now()
    await new Promise<void>((resolve, reject) => {
        fetch(url).then(res => {
            pipeline(res.body, createWriteStream(appxFilePath), (e) => {
                if (e) reject(e)
                else resolve()
            })
        }, reject)
    })
    console.log(`Downloaded asset. Took ${(Date.now() - downloadStart) / 1000}s.`)

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
        '/v',
        appxFilePath,
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

    // delete existed asset
    console.log(`Start to delete the old asset!`)
    await api.repos.deleteReleaseAsset({ owner: 'voxelum', repo: 'x-minecraft-launcher', asset_id: assetId })
    console.log(`Delete the asset ${assetId} success!`)

    const signedAppxContent = readFileSync(appxFilePath)
    // upload the new one
    console.log(`Start to upload the signed asset!`)
    const uploadStart = Date.now()
    const uploadResult = await api.repos.uploadReleaseAsset({ owner: 'voxelum', repo: 'x-minecraft-launcher', release_id: releaseId, name: assetName, data: signedAppxContent as any })
    console.log(`Upload the asset succeed! ${uploadResult.data.id}. Took ${(Date.now() - uploadStart) / 1000}s`)

    console.log(uploadResult)
}

main(Number(process.argv[2]), Number(process.argv[3]))
