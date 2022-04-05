const mbgl = require("@mapbox/mapbox-gl-native");
const mercator = new (require("@mapbox/sphericalmercator"))();
const path = require("path");
const url = require("url");
const Color = require("color");
const sharp = require("sharp");
const request = require("request");
const fetch = require("sync-fetch");

const extensionToFormat = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
};

const cachedEmptyResponses = {
  "": Buffer.alloc(0),
};

function createEmptyResponse(format, color, callback) {
  if (!format || format === "pbf") {
    callback(null, { data: cachedEmptyResponses[""] });
    return;
  }

  if (format === "jpg") {
    format = "jpeg";
  }
  if (!color) {
    color = "rgba(255,255,255,0)";
  }

  const cacheKey = `${format},${color}`;
  const data = cachedEmptyResponses[cacheKey];
  if (data) {
    callback(null, { data: data });
    return;
  }

  // create an "empty" response image
  color = new Color(color);
  const array = color.array();
  const channels = array.length === 4 && format !== "jpeg" ? 4 : 3;
  sharp(Buffer.from(array), {
    raw: {
      width: 1,
      height: 1,
      channels: channels,
    },
  })
    .toFormat(format)
    .toBuffer((err, buffer, info) => {
      if (!err) {
        cachedEmptyResponses[cacheKey] = buffer;
      }
      callback(null, { data: buffer });
    });
}

const renderer = new mbgl.Map({
  mode: "tile",
  request: (req, callback) => {
    request(
      {
        url: req.url,
        encoding: null,
        gzip: true,
      },
      (err, res, body) => {
        const parts = url.parse(req.url);
        const extension = path.extname(parts.pathname).toLowerCase();
        const format = extensionToFormat[extension] || "";
        if (err || res.statusCode < 200 || res.statusCode >= 300) {
          // console.log('HTTP error', err || res.statusCode);
          createEmptyResponse(format, "", callback);
          return;
        }

        const response = {};
        if (res.headers.modified) {
          response.modified = new Date(res.headers.modified);
        }
        if (res.headers.expires) {
          response.expires = new Date(res.headers.expires);
        }
        if (res.headers.etag) {
          response.etag = res.headers.etag;
        }

        response.data = body;
        callback(null, response);
      }
    );
  },
});

const host = "https://tiles.basemaps.linz.govt.nz";
const apiKey = ""; // Put you api key here

function getStyleJson() {
  if (apiKey === "")
    throw new Error("Missing environment variable $BASEMAPS_API_KEY");
  const url = `${host}/v1/tiles/topographic/EPSG:3857/style/topographic.json?api=${apiKey}`;
  const res = fetch(url);
  if (!res.ok)
    throw new Error(
      `Error - HTTP status: ${res.status}, statusText: ${res.statusText} url: ${url}`
    );
  const styleJson = res.json();
  return styleJson;
}

function getData(x, y, z) {
  if (apiKey === "")
    throw new Error("Missing environment variable $BASEMAPS_API_KEY");
  const url = `${host}/v1/tiles/topographic/EPSG:3857/${12}/${4035}/${2564}.pbf?api=${apiKey}`;
  const res = fetch(url);
  if (!res.ok)
    throw new Error(
      `Error - HTTP status: ${res.status}, statusText: ${res.statusText} url: ${url}`
    );
  return res.buffer();
}


// Output tile
const z = 13;
const x = 8071;
const y = 5128;
const scale = 1;
const format = "png";

const tileCenter = mercator.ll(
  [((x + 0.5) / (1 << z)) * (256 << z), ((y + 0.5) / (1 << z)) * (256 << z)],
  z
);

const mbglZ = Math.max(0, z - 1);
const params = {
  zoom: mbglZ,
  center: [tileCenter[0], tileCenter[1]],
  bearing: 0,
  pitch: 0,
  width: 128,
  height: 128,
};
if (z === 0) {
  params.width *= 2;
  params.height *= 2;
}

const data = getData(x, y, mbglZ);
const styleJson = getStyleJson();

renderer.load(styleJson);
renderer.render(params, (err) => {
  // Fix semi-transparent outlines on raw, premultiplied input
  // https://github.com/maptiler/tileserver-gl/issues/350#issuecomment-477857040
  for (var i = 0; i < data.length; i += 4) {
    var alpha = data[i + 3];
    var norm = alpha / 255;
    if (alpha === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
    } else {
      data[i] = data[i] / norm;
      data[i + 1] = data[i + 1] / norm;
      data[i + 2] = data[i + 2] / norm;
    }
  }

  const image = sharp(data, {
    raw: {
      width: params.width * scale,
      height: params.height * scale,
      channels: 4,
    },
  });

  if (z === 0) {
    // HACK: when serving zoom 0, resize the 0 tile from 512 to 256
    image.resize(width * scale, height * scale);
  }

  if (format === "png") {
    image.png({ adaptiveFiltering: false });
  } else if (format === "jpeg") {
    image.jpeg({ quality: formatQuality || 80 });
  } else if (format === "webp") {
    image.webp({ quality: formatQuality || 90 });
  }
  image.toFile(`output.${format}`, function (err) {
    if (err) {
      console.log(err);
      return;
    }
  });
});
