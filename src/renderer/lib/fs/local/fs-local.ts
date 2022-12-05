import ipc from "../../ipc"
import memoryCache from "../../memoryCache"
import { convertTimestampToMs, Semaphore, isFolderPathExcluded, isSystemPathExcluded, pathIsFileOrFolderNameIgnoredByDefault, pathValidation, windowsPathToUnixStyle, pathIncludesDot } from "../../helpers"
import { downloadChunk } from "../../api"
import { decryptData } from "../../crypto"
import { v4 as uuidv4 } from "uuid"
import db from "../../db"
import * as constants from "../../constants"
import { isSyncLocationPaused } from "../../worker/sync/sync.utils"
import type { Stats } from "fs-extra"

const fs = window.require("fs-extra")
const pathModule = window.require("path")
const readdirp = window.require("readdirp")
const log = window.require("electron-log")
const is = window.require("electron-is")
const readline = window.require("readline")

export interface ReaddirFallbackEntry {
    entry: {
        name: string,
        size: number,
        lastModified: number,
        ino: number
    },
    ino: {
        type: "folder" | "file",
        path: string
    }
}

const downloadThreadsSemaphore = new Semaphore(constants.maxDownloadThreads)
const FS_RETRIES = 64
const FS_RETRY_TIMEOUT = 500
const FS_RETRY_CODES = ["EAGAIN", "EBUSY", "ECANCELED", "EBADF", "EINTR", "EIO", "EMFILE", "ENFILE", "ENOMEM", "EPIPE", "ETXTBSY", "ESPIPE", "EAI_SYSTEM", "EAI_CANCELED"]
const FS_NORETRY_CODES = ["ENOENT", "ENODEV", "EACCES", "EPERM", "EINVAL", "ENAMETOOLONG", "ENOBUFS", "ENOSPC", "EROFS"]
const readdirFallback = new Map<string, ReaddirFallbackEntry>()
const READDIR_FALLBACK_VERSION = 1
let READDIR_FALLBACK_PATH = ""
let READDIR_FALLBACK_LOADED = false
const readdirFallbackSemaphore = new Semaphore(1)

export const getReaddirFallbackPath = async () => {
    if(READDIR_FALLBACK_PATH.length > 0){
        return READDIR_FALLBACK_PATH
    }

    const userDataPath: string = await ipc.getAppPath("userData")

    await fs.ensureDir(pathModule.join(userDataPath, "data", "v" + READDIR_FALLBACK_VERSION))

    const metadataPath: string = pathModule.join(userDataPath, "data", "v" + READDIR_FALLBACK_VERSION, "readdirFallback")

    READDIR_FALLBACK_PATH = metadataPath

    return metadataPath
}

export const loadReaddirFallbackFromDisk = async () => {
    return new Promise(async (resolve, reject) => {
        await readdirFallbackSemaphore.acquire()

        if(READDIR_FALLBACK_LOADED){
            readdirFallbackSemaphore.release()

            return resolve(true)
        }

        if(window.location.href.indexOf("#worker") == -1){
            readdirFallbackSemaphore.release()

            return resolve(true)
        }

        try{
            var path = await getReaddirFallbackPath()
        }
        catch(e: any){
            readdirFallbackSemaphore.release()

            if(e.code == "ENOENT"){
                return resolve(true)
            }

            return reject(e)
        }

        try{
            await new Promise((resolve, reject) => {
                fs.access(path, fs.constants.F_OK, (err: Error) => {
                    if(err){
                        return reject(err)
                    }

                    return resolve(true)
                })
            })
        }
        catch(e){
            readdirFallbackSemaphore.release()

            return resolve(true)
        }
    
        try{
            const reader = readline.createInterface({
                input: fs.createReadStream(path, {
                    flags: "r"
                }),
                crlfDelay: Infinity
            })
    
            reader.on("line", (line: string) => {
                if(typeof line !== "string"){
                    return
                }

                if(line.length < 4){
                    return
                }

                try{
                    const parsed = JSON.parse(line)
    
                    readdirFallback.set(parsed.key, parsed.entry)
                }
                catch(e){
                    log.error(e)
                }
            })
    
            reader.on("error", (err: any) => {
                readdirFallbackSemaphore.release()

                return reject(err)
            })

            reader.on("close", () => {
                readdirFallbackSemaphore.release()

                READDIR_FALLBACK_LOADED = true

                log.info("Readdir fallback loaded successfully")

                return resolve(true)
            })
        }
        catch(e){
            readdirFallbackSemaphore.release()

            return reject(e)
        }
    })
}

export const saveReaddirFallbackToDisk = async (key: string, entry: ReaddirFallbackEntry) => {
    if(window.location.href.indexOf("#worker") == -1){
        return true
    }

    await readdirFallbackSemaphore.acquire()

    try{
        const path = await getReaddirFallbackPath()

        await new Promise((resolve, reject) => {
            fs.appendFile(path, JSON.stringify({
                key,
                entry
            }) + "\n", (err: any) => {
                if(err){
                    return reject(err)
                }

                return resolve(true)
            })
        })
    }
    catch(e){
        log.error(e)
    }

    readdirFallbackSemaphore.release()

    return true
}

export const normalizePath = (path: string): string => {
    return pathModule.normalize(path)
}

export const checkLastModified = (path: string): Promise<{ changed: boolean, mtimeMs?: number }> => {
    return new Promise((resolve, reject) => {
        path = normalizePath(path)

        gracefulLStat(path).then((stat: any) => {
            if(stat.mtimeMs > 0){
                return resolve({
                    changed: false
                })
            }

            const lastModified = new Date(new Date().getTime() - 60000)
            const mtimeMs = lastModified.getTime()
            
            let currentTries = 0
            let lastErr: any = undefined

            const req = () => {
                if(currentTries > FS_RETRIES){
                    return reject(lastErr)
                }

                currentTries += 1

                fs.utimes(path, lastModified, lastModified).then(() => {
                    return resolve({
                        changed: true,
                        mtimeMs 
                    })
                }).catch((err: any) => {
                    lastErr = err

                    if(FS_RETRY_CODES.includes(err.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }
                    
                    return reject(err)
                })
            }

            return req()
        }).catch(reject)
    })
}

export const getTempDir = async (): Promise<string> => {
    if(memoryCache.has("tmpDir")){
        return memoryCache.get("tmpDir")
    }

    const tmpDirRes = await ipc.getAppPath("temp")
    const tmpDir = normalizePath(tmpDirRes)

    memoryCache.set("tmpDir", tmpDir)

    return tmpDir
}

export const smokeTest = (path: string): Promise<boolean> => {
    return new Promise(async (resolve, reject) => {
        path = normalizePath(path)

        try{
            const tmpDir = await getTempDir()

            if(!(await canReadWriteAtPath(path))){
                return reject(new Error("Cannot read/write at path " + path))
            }

            if(!(await canReadWriteAtPath(tmpDir))){
                return reject(new Error("Cannot read/write at path " + tmpDir))
            }

            await Promise.all([
                gracefulLStat(path),
                gracefulLStat(tmpDir)
            ])
        }
        catch(e){
            return reject(e)
        }

        return resolve(true)
    })
}

export const gracefulLStat = (path: string): Promise<any> => {
    return new Promise((resolve, reject) => {
        path = pathModule.normalize(path)

        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                return reject(lastErr)
            }

            currentTries += 1

            fs.lstat(path).then(resolve).catch((err: any) => {
                lastErr = err

                if(FS_RETRY_CODES.includes(err.code)){
                    return setTimeout(req, FS_RETRY_TIMEOUT)
                }

                return reject(err)
            })
        }

        return req()
    })
}

export const canReadAtPath = (fullPath: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                log.error(lastErr)
                
                return resolve(false)
            }

            currentTries += 1

            fs.access(pathModule.normalize(fullPath), fs.constants.F_OK | fs.constants.R_OK, (err: any) => {
                if(err){
                    lastErr = err

                    if(FS_RETRY_CODES.includes(err.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }
                    
                    log.error(lastErr)
                
                    return resolve(false)
                }
    
                return resolve(true)
            })
        }

        return req()
    })
}

export const canWriteAtPath = (fullPath: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                log.error(lastErr)

                return resolve(false)
            }

            currentTries += 1

            fs.access(pathModule.normalize(fullPath), fs.constants.F_OK | fs.constants.W_OK, (err: any) => {
                if(err){
                    lastErr = err

                    if(FS_RETRY_CODES.includes(err.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }

                    log.error(lastErr)
                
                    return resolve(false)
                }
                
                return resolve(true)
            })
        }

        return req()
    })
}

export const canReadWriteAtPath = (fullPath: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                log.error(lastErr)
                
                return resolve(false)
            }

            currentTries += 1

            fs.access(pathModule.normalize(fullPath), fs.constants.F_OK | fs.constants.R_OK | fs.constants.W_OK, (err: any) => {
                if(err){
                    lastErr = err

                    if(FS_RETRY_CODES.includes(err.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }
                    
                    log.error(lastErr)
                
                    return resolve(false)
                }
    
                return resolve(true)
            })
        }

        return req()
    })
}

export const directoryTree = (path: string, skipCache: boolean = false, location?: any): Promise<any> => {
    return new Promise((resolve, reject) => {
        const cacheKey = "directoryTreeLocal:" + location.uuid

        Promise.all([
            db.get("localDataChanged:" + location.uuid),
            db.get(cacheKey),
            db.get("excludeDot")
        ]).then(async ([localDataChanged, cachedLocalTree, excludeDot]) => {
            if(excludeDot == null){
                excludeDot = true
            }
            
            if(!localDataChanged && cachedLocalTree !== null && !skipCache){
                return resolve({
                    changed: false,
                    data: cachedLocalTree
                })
            }

            try{
                await loadReaddirFallbackFromDisk()
            }
            catch(e){
                log.error(e)
            }

            path = normalizePath(path)

            const files: { [key: string]: { name: string, lastModified: number, ino: number, size: number } } = {}
            const folders: { [key: string]: { name: string, lastModified: number, ino: number } } = {}
            const ino: { [key: number]: { type: string, path: string } } = {}
            const windows: boolean = is.windows()
            let statting: number = 0

            const dirStream = readdirp(path, {
                alwaysStat: false,
                lstat: false,
                type: "all",
                depth: 2147483648,
                directoryFilter: ["!.filen.trash.local", "!System Volume Information"],
                fileFilter: ["!.filen.trash.local", "!System Volume Information"]
            })
            
            dirStream.on("data", async (item: { path: string, fullPath: string, basename: string, stats: Stats }) => {
                statting += 1

                const readdirFallbackKey = location.uuid + ":" + item.fullPath

                try{
                    if(windows){
                        item.path = windowsPathToUnixStyle(item.path)
                    }

                    let include = true
    
                    if(excludeDot && (item.basename.startsWith(".") || pathIncludesDot(item.path))){
                        include = false
                    }

                    if(!(await canReadWriteAtPath(item.fullPath))){
                        if(readdirFallback.has(readdirFallbackKey)){
                            const fallback = readdirFallback.get(readdirFallbackKey)

                            if(fallback){
                                files[item.path] = fallback.entry
                                ino[fallback.entry.ino] = fallback.ino

                                log.error("Using fallback readdir entry for " + item.path)

                                return
                            }
                        }

                        include = false
                    }
    
                    if(
                        include
                        && !isFolderPathExcluded(item.path)
                        && pathValidation(item.path)
                        && !pathIsFileOrFolderNameIgnoredByDefault(item.path)
                        && !isSystemPathExcluded("//" + item.fullPath)
                    ){
                        item.stats = await gracefulLStat(item.fullPath)

                        if(!item.stats.isSymbolicLink()){
                            if(item.stats.isDirectory()){
                                const inoNum = parseInt(item.stats.ino.toString())
                                const entry = {
                                    name: item.basename,
                                    size: 0,
                                    lastModified: convertTimestampToMs(parseInt(item.stats.mtimeMs.toString())), //.toString() because of BigInt
                                    ino: inoNum
                                }

                                folders[item.path] = entry
                                ino[inoNum] = {
                                    type: "folder",
                                    path: item.path
                                }

                                if(!readdirFallback.has(readdirFallbackKey)){
                                    const readdirFallbackEntry: ReaddirFallbackEntry = {
                                        entry,
                                        ino: {
                                            type: "folder",
                                            path: item.path
                                        }
                                    }
    
                                    readdirFallback.set(readdirFallbackKey, readdirFallbackEntry)
    
                                    saveReaddirFallbackToDisk(readdirFallbackKey, readdirFallbackEntry).catch(log.error)
                                }
                            }
                            else{
                                if(item.stats.size > 0){
                                    const inoNum = parseInt(item.stats.ino.toString())
                                    const entry = {
                                        name: item.basename,
                                        size: parseInt(item.stats.size.toString()), //.toString() because of BigInt
                                        lastModified: convertTimestampToMs(parseInt(item.stats.mtimeMs.toString())), //.toString() because of BigInt
                                        ino: inoNum
                                    }

                                    files[item.path] = entry
                                    ino[inoNum] = {
                                        type: "file",
                                        path: item.path
                                    }

                                    if(!readdirFallback.has(readdirFallbackKey)){
                                        const readdirFallbackEntry: ReaddirFallbackEntry = {
                                            entry,
                                            ino: {
                                                type: "file",
                                                path: item.path
                                            }
                                        }
    
                                        readdirFallback.set(readdirFallbackKey, readdirFallbackEntry)
    
                                        saveReaddirFallbackToDisk(readdirFallbackKey, readdirFallbackEntry).catch(log.error)
                                    }
                                }
                                else{
                                    if(readdirFallback.has(readdirFallbackKey)){
                                        const fallback = readdirFallback.get(readdirFallbackKey)

                                        if(fallback){
                                            files[item.path] = fallback.entry
                                            ino[fallback.entry.ino] = fallback.ino

                                            log.error("Using fallback readdir entry for " + item.path)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                catch(e){
                    log.error(e)

                    if(readdirFallback.has(readdirFallbackKey)){
                        const fallback = readdirFallback.get(readdirFallbackKey)

                        if(fallback){
                            files[item.path] = fallback.entry
                            ino[fallback.entry.ino] = fallback.ino

                            log.error("Using fallback readdir entry for " + item.path)
                        }
                    }
                }

                statting -= 1
            })
            
            dirStream.on("warn", (warn: any) => {
                log.error("Readdirp warning:", warn)
            })
            
            dirStream.on("error", (err: Error) => {
                dirStream.destroy()

                statting = 0
                
                return reject(err)
            })
            
            dirStream.on("end", async () => {
                await new Promise((resolve) => {
                    if(statting <= 0){
                        return resolve(true)
                    }

                    const wait = setInterval(() => {
                        if(statting <= 0){
                            clearInterval(wait)

                            return resolve(true)
                        }
                    }, 10)
                })

                statting = 0

                dirStream.destroy()
                
                const obj = {
                    files,
                    folders,
                    ino
                }

                try{
                    await Promise.all([
                        db.set(cacheKey, obj),
                        db.set("localDataChanged:" + location.uuid, false)
                    ])
                }
                catch(e){
                    return reject(e)
                }

                return resolve({
                    changed: true,
                    data: obj
                })
            })
        }).catch(reject)
    })
}

export const readChunk = (path: string, offset: number, length: number): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        path = pathModule.normalize(path)

        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                return reject(lastErr)
            }

            currentTries += 1

            fs.open(path, "r", (err: any, fd: any) => {
                if(err){
                    lastErr = err
            
                    if(FS_RETRY_CODES.includes(err.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }
                    
                    return reject(err)
                }
    
                const buffer = Buffer.alloc(length)
    
                fs.read(fd, buffer, 0, length, offset, (err: any, read: any) => {
                    if(err){
                        lastErr = err
            
                        if(FS_RETRY_CODES.includes(err.code)){
                            return setTimeout(req, FS_RETRY_TIMEOUT)
                        }
                        
                        return reject(err)
                    }
    
                    let data: any = undefined
    
                    if(read < length){
                        data = buffer.slice(0, read)
                    }
                    else{
                        data = buffer
                    }
    
                    fs.close(fd, (err: any) => {
                        if(err){
                            lastErr = err
            
                            if(FS_RETRY_CODES.includes(err.code)){
                                return setTimeout(req, FS_RETRY_TIMEOUT)
                            }
                            
                            return reject(err)
                        }
    
                        return resolve(data)
                    })
                })
            })
        }

        return req()
    })
}

export const rm = (path: string): Promise<boolean> => {
    return new Promise(async (resolve, reject) => {
        path = normalizePath(path)

        try{
            var stats = await gracefulLStat(path)
        }
        catch(e: any){
            if(e.code == "ENOENT"){
                return resolve(true)
            }

            return reject(e)
        }

        let currentTries = 0
        let lastErr: any = undefined

        const req = async (): Promise<any> => {
            if(currentTries > FS_RETRIES){
                return reject(lastErr)
            }

            currentTries += 1
        
            if(stats.isSymbolicLink()){
                try{
                    await fs.unlink(path)
                }
                catch(e: any){
                    lastErr = e

                    if(e.code == "ENOENT"){
                        return resolve(true)
                    }

                    if(FS_RETRY_CODES.includes(e.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }
                    
                    return reject(e)
                }
            }
            else{
                try{
                    await fs.remove(path)
                }
                catch(e: any){
                    lastErr = e

                    if(e.code == "ENOENT"){
                        return resolve(true)
                    }

                    if(FS_RETRY_CODES.includes(e.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }
                    
                    return reject(e)
                }
            }
    
            return resolve(true)
        }

        return req()
    })
}

export const mkdir = (path: string, location: any, task: any): Promise<any> => {
    return new Promise((resolve, reject) => {
        const absolutePath = normalizePath(location.local + "/" + path)
        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                return reject(lastErr)
            }

            currentTries += 1

            fs.ensureDir(absolutePath).then(() => {
                gracefulLStat(absolutePath).then(resolve).catch((err: any) => {
                    lastErr = err
    
                    if(FS_RETRY_CODES.includes(err.code)){
                        return setTimeout(req, FS_RETRY_TIMEOUT)
                    }

                    return reject(err)
                })
            }).catch((err: any) => {
                lastErr = err

                if(FS_RETRY_CODES.includes(err.code)){
                    return setTimeout(req, FS_RETRY_TIMEOUT)
                }
                
                return reject(err)
            })
        }

        return req()
    })
}

export const download = (path: string, location: any, task: any): Promise<any> => {
    return new Promise(async (resolve, reject) => {
        await new Promise((resolve) => {
            const getPausedStatus = () => {
                Promise.all([
                    db.get("paused"),
                    isSyncLocationPaused(location.uuid)
                ]).then(([paused, locationPaused]) => {
                    if(paused || locationPaused){
                        return setTimeout(getPausedStatus, 1000)
                    }

                    return resolve(true)
                }).catch((err) => {
                    log.error(err)

                    return setTimeout(getPausedStatus, 1000)
                })
            }

            return getPausedStatus()
        })

        try{
            var absolutePath = normalizePath(location.local + "/" + path)
            var file = task.item
        }
        catch(e){
            return reject(e)
        }

        getTempDir().then((tmpDir) => {
            try{
                var fileTmpPath = normalizePath(tmpDir + "/" + uuidv4())
            }
            catch(e){
                return reject(e)
            }

            Promise.all([
                rm(absolutePath),
                rm(fileTmpPath)
            ]).then(async () => {
                try{
                    var stream = fs.createWriteStream(fileTmpPath)
                }
                catch(e){
                    return reject(e)
                }

                const fileChunks = file.chunks
                let currentWriteIndex = 0

                const downloadTask = (index: number): Promise<{ index: number, data: Buffer }> => {
                    return new Promise((resolve, reject) => {
                        downloadChunk({ 
                            region: file.region,
                            bucket: file.bucket,
                            uuid: file.uuid,
                            index,
                            from: "sync",
                            location
                        }).then((data) => {
                            decryptData(data, file.metadata.key, file.version).then((decrypted) => {
                                return resolve({
                                    index,
                                    data: Buffer.from(decrypted)
                                })
                            }).catch(reject)
                        }).catch(reject)
                    })
                }

                const writeChunk = (index: number, data: Buffer) => {
                    if(index !== currentWriteIndex){
                        return setTimeout(() => {
                            writeChunk(index, data)
                        }, 10)
                    }

                    stream.write(data, (err: any) => {
                        if(err){
                            return reject(err)
                        }

                        currentWriteIndex += 1

                        return true
                    })
                }

                try{
                    await new Promise((resolve, reject) => {
                        let done = 0

                        for(let i = 0; i < fileChunks; i++){
                            downloadThreadsSemaphore.acquire().then(() => {
                                downloadTask(i).then(({ index, data }) => {
                                    writeChunk(index, data)

                                    done += 1

                                    downloadThreadsSemaphore.release()

                                    if(done >= fileChunks){
                                        return resolve(true)
                                    }
                                }).catch((err) => {
                                    downloadThreadsSemaphore.release()

                                    return reject(err)
                                })
                            })
                        }
                    })

                    await new Promise((resolve) => {
                        if(currentWriteIndex >= fileChunks){
                            return resolve(true)
                        }

                        const wait = setInterval(() => {
                            if(currentWriteIndex >= fileChunks){
                                clearInterval(wait)

                                return resolve(true)
                            }
                        }, 10)
                    })

                    await new Promise((resolve, reject) => {
                        stream.close((err: any) => {
                            if(err){
                                return reject(err)
                            }

                            return resolve(true)
                        })
                    })
                }
                catch(e){
                    fs.unlink(fileTmpPath, () => {})

                    return reject(e)
                }

                const now = new Date().getTime()
                const lastModified = convertTimestampToMs(typeof file.metadata.lastModified == "number" ? file.metadata.lastModified : now)
                const utimesLastModified = typeof lastModified == "number" && lastModified > 0 && now > lastModified ? lastModified : (now - 60000)

                move(fileTmpPath, absolutePath).then(() => {
                    fs.utimes(absolutePath, new Date(utimesLastModified), new Date(utimesLastModified)).then(() => {
                        checkLastModified(absolutePath).then(() => {
                            gracefulLStat(absolutePath).then((stat: any) => {
                                if(stat.size <= 0){
                                    rm(absolutePath)
            
                                    return reject(new Error(absolutePath + " size = " + stat.size))
                                }
                                
                                return resolve(stat)
                            }).catch(reject)
                        }).catch(reject)
                    }).catch(reject)
                }).catch(reject)
            }).catch(reject)
        }).catch(reject)
    })
}

export const move = (before: string, after: string, overwrite: boolean = true): Promise<any> => {
    return new Promise((resolve, reject) => {
        try{
            before = normalizePath(before)
            after = normalizePath(after)
        }
        catch(e){
            return reject(e)
        }

        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                return reject(lastErr)
            }

            currentTries += 1

            fs.move(before, after, {
                overwrite
            }).then(resolve).catch((err: any) => {
                lastErr = err

                if(FS_RETRY_CODES.includes(err.code)){
                    return setTimeout(req, FS_RETRY_TIMEOUT)
                }
                
                return reject(err)
            })
        }

        return req()
    })
}

export const rename = (before: string, after: string): Promise<any> => {
    return new Promise((resolve, reject) => {
        try{
            before = normalizePath(before)
            after = normalizePath(after)
        }
        catch(e){
            return reject(e)
        }

        let currentTries = 0
        let lastErr: any = undefined

        const req = () => {
            if(currentTries > FS_RETRIES){
                return reject(lastErr)
            }

            currentTries += 1

            fs.rename(before, after).then(resolve).catch((err: any) => {
                lastErr = err

                if(FS_RETRY_CODES.includes(err.code)){
                    return setTimeout(req, FS_RETRY_TIMEOUT)
                }

                return reject(err)
            })
        }

        return req()
    })
}