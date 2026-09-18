#!/usr/bin/env node
// Fetches the latest available NOAA GFS 10m wind analysis (U + V components, 1-degree global
// grid) from NOMADS, converts it to the two-grid JSON shape the `leaflet-velocity` Leaflet
// plugin expects, and writes it to wind-data/latest.json + wind-data/meta.json.
//
// Deliberately does NOT run wind-server's own Express server (it's designed to stay running
// forever, never exits) - this replicates just its two real steps (build the NOMADS filter URL
// for a given cycle, then shell out to grib2json) as a plain one-shot script, meant to be run
// once per GitHub Actions job.
//
// Requires: Node 18+ (built-in fetch), and converter/bin/grib2json + converter/lib/*.jar
// (vendored from https://github.com/Flowm/wind-server by the workflow before this runs), plus
// JAVA_HOME pointing at a JRE (grib2json is a thin Java wrapper).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GRIB_DIR = path.join(__dirname, '..', 'grib-data');
const OUT_DIR = path.join(__dirname, '..', 'wind-data');
const CONVERTER = path.join(__dirname, '..', 'converter', 'bin', 'grib2json');

// GFS publishes on a 6-hourly cycle (00/06/12/18 UTC) but each cycle's 1-degree filtered
// products typically aren't actually available on NOMADS until roughly 3.5-5 hours after the
// cycle's nominal time. Rather than hard-coding that latency, just try the most recent
// 6-hour-aligned cycle first and fall back to earlier ones on failure - mirrors wind-server's
// own retry behaviour (`nextFile` falling back one cycle at a time).
function cycleCandidates(maxAttempts) {
    const now = new Date();
    // Floor to the most recent 6-hour boundary (00/06/12/18 UTC).
    let cycle = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        Math.floor(now.getUTCHours() / 6) * 6, 0, 0
    ));
    const out = [];
    for (let i = 0; i < maxAttempts; i++) {
        out.push(new Date(cycle));
        cycle = new Date(cycle.getTime() - 6 * 60 * 60 * 1000);
    }
    return out;
}

function nomadsUrl(cycleDate) {
    const yyyy = cycleDate.getUTCFullYear();
    const mm = String(cycleDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cycleDate.getUTCDate()).padStart(2, '0');
    const hh = String(cycleDate.getUTCHours()).padStart(2, '0');
    const params = new URLSearchParams({
        file: `gfs.t${hh}z.pgrb2.1p00.f000`,
        lev_10_m_above_ground: 'on',
        var_UGRD: 'on',
        var_VGRD: 'on',
        leftlon: '0',
        rightlon: '360',
        toplat: '90',
        bottomlat: '-90',
        dir: `/gfs.${yyyy}${mm}${dd}/${hh}/atmos`
    });
    return {
        url: `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl?${params.toString()}`,
        label: `${yyyy}-${mm}-${dd}T${hh}:00:00Z`
    };
}

async function fetchGrib(cycleDate) {
    const { url, label } = nomadsUrl(cycleDate);
    console.log(`Trying GFS cycle ${label} ...`);
    const res = await fetch(url);
    if (!res.ok) {
        console.log(`  -> HTTP ${res.status}, trying an earlier cycle`);
        return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // A real GRIB2 file starts with the 4-byte magic "GRIB". NOMADS returns a small HTML/text
    // error page (not this magic) when a cycle isn't published yet or the params are rejected -
    // catching that here avoids silently "succeeding" with garbage input to grib2json.
    if (buf.length < 1000 || buf.toString('ascii', 0, 4) !== 'GRIB') {
        console.log(`  -> response wasn't a GRIB2 file (${buf.length} bytes), trying an earlier cycle`);
        return null;
    }
    console.log(`  -> got ${(buf.length / 1024).toFixed(0)} KB of real GRIB2 data`);
    return { buf, label };
}

async function main() {
    fs.mkdirSync(GRIB_DIR, { recursive: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    let result = null;
    for (const cycle of cycleCandidates(5)) { // covers up to 30h back - generous safety margin
        result = await fetchGrib(cycle);
        if (result) break;
    }
    if (!result) {
        console.error('Could not fetch a usable GFS cycle after several attempts - leaving the previous wind-data/latest.json in place.');
        process.exit(1);
    }

    const gribPath = path.join(GRIB_DIR, 'gfs.grib2');
    fs.writeFileSync(gribPath, result.buf);

    const outPath = path.join(OUT_DIR, 'latest.json');
    // --data: include the actual grid values, not just headers. --names: human-readable
    // parameter names in the header. --compact: minified JSON (this file gets fetched by the
    // app on every load, so size matters).
    execFileSync(CONVERTER, ['--data', '--output', outPath, '--names', '--compact', gribPath], {
        stdio: 'inherit',
        maxBuffer: 20 * 1024 * 1024
    });

    const stat = fs.statSync(outPath);
    console.log(`Wrote ${outPath} (${(stat.size / 1024).toFixed(0)} KB)`);

    fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify({
        cycle: result.label,
        generatedAt: new Date().toISOString(),
        source: 'NOAA GFS 1.00-degree, 10m wind, via NOMADS'
    }, null, 2));

    // Clean up the (large, binary) intermediate GRIB2 file so it never gets committed.
    fs.rmSync(GRIB_DIR, { recursive: true, force: true });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
