import initialisePopup from "@flourish/info-popup";

export var data = {};

export var state = {
  map_style: "https://tiles.openfreemap.org/styles/liberty",
  base_hide_labels: false,
  base_land_color: null,
  base_water_color: null,
  base_road_color: null,
  base_border_color: null,
  base_label_color: null,
  base_label_halo: null,
  base_label_opacity: 1,
  base_label_halo_opacity: 1,
  start_lat: 30,
  start_lon: 0,
  start_zoom: 1.5,
  point_radius: 6,
  point_opacity: 1,
  point_scale_with_zoom: false,
  point_scale_factor: 2,
  point_min_zoom: 0,
  point_max_zoom: 24,
  category_colors: ["#1D6996", "#EDAD08", "#0F8554", "#CC503E", "#5F4690", "#38A6A5"],
  color_overrides: "Historic Landmark: #990F4B",
  search_placeholder: "Search locations…",
  search_zoom: 12,
  popup: {},
  annotations_show: false,
  annotation_devices: "all",
  annotation_min_zoom: 0,
  annotation_text_size: 13,
  annotation_font_weight: "400",
  annotation_text_color: "#222222",
  annotation_bg_color: "#ffffff",
  annotation_bg_opacity: 0.9,
  annotation_max_width: 180,
  annotation_padding: 6,
  annotation_radius: 4,
  annotation_offset_x: 0,
  annotation_offset_y: -40,
  annotation_connector: true,
  annotation_connector_color: "#333333",
  annotation_connector_width: 1,
  annotation_dot: true
};

var map, popup, currentStyle;
var hoveredIdx = null;
var mapReady = false;
var annotationMarkers = [];

export function draw() {
  currentStyle = state.map_style;
  map = new maplibregl.Map({
    container: "map",
    style: state.map_style,
    center: [state.start_lon, state.start_lat],
    zoom: state.start_zoom,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  // No containers passed, so the panel covers the whole visualization
  popup = initialisePopup(state.popup);
  popup.titleKey("name");
  popup.getLockedPosition(function (locked_id) {
    var row = rows()[+locked_id];
    if (!row || !coords(row)) return null;
    return [screenPos(row), row];
  });

  map.on("style.load", function () {
    addPointLayer();
    captureBaseDefaults();
    mapReady = true;
    update();
  });

  // Hover
  map.on("mousemove", "points", function (e) {
    var idx = e.features[0].properties.idx;
    map.getCanvas().style.cursor = "pointer";
    if (idx === hoveredIdx) return;
    hoveredIdx = idx;
    popup.mouseover(screenPos(rows()[idx]), rows()[idx]);
  });
  map.on("mouseleave", "points", function () {
    map.getCanvas().style.cursor = "";
    hoveredIdx = null;
    popup.mouseout();
  });

  // Click: lock open on a point, close when clicking empty map
  map.on("click", function (e) {
    var hits = mapReady ? map.queryRenderedFeatures(e.point, { layers: ["points"] }) : [];
    if (hits.length) openLocked(hits[0].properties.idx);
    else popup.clickout();
  });

  // Keep a locked popup pinned to its point while the map pans/zooms
  map.on("move", function () {
    if (popup.locked() != null) popup.update();
  });

  map.on("zoom", updateAnnotationVisibility);
  map.on("resize", updateAnnotationVisibility);

  initSearch();
}

export function update() {
  if (!map) return;
  if (state.map_style !== currentStyle) {
    currentStyle = state.map_style;
    mapReady = false;
    map.setStyle(state.map_style);
    return; // style.load will call update() again
  }
  if (!mapReady) return;
  applyBasePalette();
  map.getSource("points").setData({ type: "FeatureCollection", features: buildFeatures() });
  map.setPaintProperty("points", "circle-radius", radiusValue());
  map.setPaintProperty("points", "circle-opacity", state.point_opacity);
  map.setLayerZoomRange("points", state.point_min_zoom, state.point_max_zoom);
  map.setPaintProperty("points", "circle-color", colorExpression());
  document.getElementById("search-input").placeholder = state.search_placeholder;

  renderAnnotations();

  popup
    .setColumnNames(rows().column_names || {})
    .hideColumnNames(["lat", "lon"])
    .update();
}

// ---------- points ----------

function rows() { return data.points || []; }

function coords(row) {
  var lat = parseFloat(row.lat), lon = parseFloat(row.lon);
  return isFinite(lat) && isFinite(lon) ? [lon, lat] : null;
}

function radiusValue() {
  var r = state.point_radius;
  if (!state.point_scale_with_zoom) return r;
  // Normal size up to zoom 2, growing steadily to r × factor by zoom 14
  return ["interpolate", ["linear"], ["zoom"], 2, r, 14, r * state.point_scale_factor];
}

function addPointLayer() {
  map.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "points",
    type: "circle",
    source: "points",
    paint: {
      "circle-radius": radiusValue(),
      "circle-opacity": state.point_opacity,
      "circle-color": "#888888",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff"
    }
  });
}

function buildFeatures() {
  var out = [];
  rows().forEach(function (row, i) {
    var c = coords(row);
    if (!c) return;
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: c },
      properties: { idx: i, category: row.category || "" }
    });
  });
  return out;
}

function categoryColors() {
  var lookup = {};
  (state.color_overrides || "").split("\n").forEach(function (line) {
    var i = line.lastIndexOf(":");
    if (i > 0) lookup[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  var palette = state.category_colors || ["#888888"];
  var p = 0;
  rows().forEach(function (row) {
    var cat = row.category || "";
    if (!(cat in lookup)) lookup[cat] = palette[p++ % palette.length];
  });
  return lookup;
}

function colorExpression() {
  var colors = categoryColors();
  var cats = Object.keys(colors);
  if (!cats.length) return "#888888";
  var expr = ["match", ["get", "category"]];
  cats.forEach(function (c) { expr.push(c, colors[c]); });
  expr.push("#888888"); // fallback
  return expr;
}

// function showPopup(idx) {
//   var row = rows()[idx];
//   var c = row && coords(row);
//   if (!c) return;

//   var el = document.createElement("div");
//   var title = document.createElement("strong");
//   title.textContent = row.name;
//   el.appendChild(title);

//   var headers = (rows().column_names && rows().column_names.info) || [];
//   (row.info || []).forEach(function (val, i) {
//     if (!val) return;
//     var p = document.createElement("p");
//     var label = document.createElement("b");
//     label.textContent = (headers[i] || "") + ": ";
//     p.appendChild(label);
//     p.appendChild(document.createTextNode(val));
//     el.appendChild(p);
//   });

//   popup.setLngLat(c).setDOMContent(el).addTo(map);
// }

function screenPos(row) {
  var p = map.project(coords(row));
  return [p.x, p.y];
}

function openLocked(idx) {
  popup.click(screenPos(rows()[idx]), rows()[idx], String(idx));
}

// ---------- search ----------

function initSearch() {
  var input = document.getElementById("search-input");
  var list = document.getElementById("search-results");
  var active = -1;
  input.placeholder = state.search_placeholder;

  function render(matches) {
    list.innerHTML = "";
    active = -1;
    matches.forEach(function (m) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.idx = m.idx;
      li.textContent = m.row.name;
      if (m.row.category) {
        var sub = document.createElement("span");
        sub.textContent = m.row.category;
        li.appendChild(sub);
      }
      // mousedown (not click) so it fires before the input's blur clears the list
      li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(m.idx); });
      list.appendChild(li);
    });
  }

  function choose(idx) {
    var row = rows()[idx];
    input.value = row.name;
    render([]);
    popup.clickout();
    map.flyTo({ center: coords(row), zoom: state.search_zoom, essential: true });
    map.once("moveend", function () { openLocked(idx); });
  }

  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    if (q.length < 2) { render([]); return; }
    var matches = [];
    rows().forEach(function (row, idx) {
      var name = (row.name || "").toLowerCase();
      if (coords(row) && name.includes(q)) matches.push({ row: row, idx: idx, pos: name.indexOf(q) });
    });
    matches.sort(function (a, b) { return a.pos - b.pos; }); // names starting with the query first
    render(matches.slice(0, 8));
  });

  input.addEventListener("keydown", function (e) {
    var items = list.children;
    if (e.key === "Escape") { render([]); return; }
    if (!items.length) return;
    if (e.key === "ArrowDown") active = Math.min(active + 1, items.length - 1);
    else if (e.key === "ArrowUp") active = Math.max(active - 1, 0);
    else if (e.key === "Enter") { choose(+(items[active] || items[0]).dataset.idx); return; }
    else return;
    e.preventDefault();
    Array.prototype.forEach.call(items, function (li, i) { li.classList.toggle("active", i === active); });
  });

  input.addEventListener("blur", function () { render([]); });
}

// ---------- annotations ----------

var SVG_NS = "http://www.w3.org/2000/svg";

function numOr(value, fallback) {
  var n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

function withOpacity(hex, alpha) {
  var h = (hex || "#ffffff").replace("#", "");
  if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
  var n = parseInt(h, 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")";
}

function renderAnnotations() {
  annotationMarkers.forEach(function (m) { m.remove(); });
  annotationMarkers = [];
  if (!state.annotations_show) return;

  (data.annotations || []).forEach(function (row) {
    var lat = parseFloat(row.lat), lon = parseFloat(row.lon);
    if (!row.label || !isFinite(lat) || !isFinite(lon)) return;
    var dx = numOr(row.offset_x, state.annotation_offset_x);
    var dy = numOr(row.offset_y, state.annotation_offset_y);
    var marker = new maplibregl.Marker({ element: buildAnnotation(row.label, dx, dy), anchor: "center" })
      .setLngLat([lon, lat])
      .addTo(map);
    annotationMarkers.push(marker);
  });

  updateAnnotationVisibility();
}

function buildAnnotation(text, dx, dy) {
  var root = document.createElement("div");
  root.className = "annotation";

  if (state.annotation_connector && (dx || dy)) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "annotation-connector");
    var line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", 0);
    line.setAttribute("y1", 0);
    line.setAttribute("x2", dx);
    line.setAttribute("y2", dy);
    line.setAttribute("stroke", state.annotation_connector_color);
    line.setAttribute("stroke-width", state.annotation_connector_width);
    svg.appendChild(line);
    root.appendChild(svg);
  }

  if (state.annotation_dot) {
    var dot = document.createElement("div");
    dot.className = "annotation-dot";
    dot.style.background = state.annotation_connector_color;
    root.appendChild(dot);
  }

  var label = document.createElement("div");
  label.className = "annotation-label";
  label.textContent = text;
  label.style.left = dx + "px";
  label.style.top = dy + "px";
  label.style.fontSize = state.annotation_text_size + "px";
  label.style.fontWeight = state.annotation_font_weight;
  label.style.color = state.annotation_text_color;
  label.style.background = withOpacity(state.annotation_bg_color, state.annotation_bg_opacity);
  label.style.padding = state.annotation_padding + "px";
  label.style.borderRadius = state.annotation_radius + "px";
  label.style.maxWidth = state.annotation_max_width + "px";
  root.appendChild(label);

  return root;
}

function updateAnnotationVisibility() {
  if (!map) return;
  var isMobile = window.innerWidth < 600;
  var deviceOk = state.annotation_devices === "all" ||
    (state.annotation_devices === "mobile" ? isMobile : !isMobile);
  var zoomOk = map.getZoom() >= state.annotation_min_zoom;
  annotationMarkers.forEach(function (m) {
    m.getElement().style.display = deviceOk && zoomOk ? "" : "none";
  });
}


// ---------- base map palette ----------

// Which style layers each color setting controls (OpenMapTiles schema)
var PALETTE_RULES = [
  { setting: "base_land_color", prop: "background-color", test: function (l) { return l.type === "background"; } },
  { setting: "base_water_color", prop: "fill-color", test: function (l) { return l["source-layer"] === "water" && l.type === "fill"; } },
  { setting: "base_water_color", prop: "line-color", test: function (l) { return l["source-layer"] === "waterway" && l.type === "line"; } },
  { setting: "base_road_color", prop: "line-color", test: function (l) { return l["source-layer"] === "transportation" && l.type === "line"; } },
  { setting: "base_border_color", prop: "line-color", test: function (l) { return l["source-layer"] === "boundary" && l.type === "line"; } },
  { setting: "base_label_color", prop: "text-color", test: function (l) { return l.type === "symbol"; } },
  { setting: "base_label_halo", prop: "text-halo-color", test: function (l) { return l.type === "symbol"; } },
  { setting: "base_label_opacity", prop: "text-opacity", test: function (l) { return l.type === "symbol"; } }
];

var baseDefaults = {};

function baseLayers() {
  // Only the base map's own layers, never the template's points layer
  return map.getStyle().layers.filter(function (l) { return l.id !== "points"; });
}

function captureBaseDefaults() {
  baseDefaults = {};
  baseLayers().forEach(function (layer) {
    PALETTE_RULES.forEach(function (rule) {
      if (rule.test(layer)) {
        baseDefaults[layer.id + "|" + rule.prop] = map.getPaintProperty(layer.id, rule.prop);
      }
    });
    if (layer.type === "symbol") {
      baseDefaults[layer.id + "|visibility"] = map.getLayoutProperty(layer.id, "visibility") || "visible";
    }
  });
}

function applyBasePalette() {
  baseLayers().forEach(function (layer) {
    PALETTE_RULES.forEach(function (rule) {
      if (!rule.test(layer)) return;
      var custom = customValue(rule);
      // No custom value restores the style's original value
      map.setPaintProperty(layer.id, rule.prop,
        custom != null ? custom : baseDefaults[layer.id + "|" + rule.prop]);
    });
    if (layer.type === "symbol") {
      map.setLayoutProperty(layer.id, "visibility",
        state.base_hide_labels ? "none" : baseDefaults[layer.id + "|visibility"]);
    }
  });

  function customValue(rule) {
    var v = state[rule.setting];
    if (rule.setting === "base_label_opacity") {
      return v < 1 ? v : null; // 1 = untouched, keep the style's own opacity
    }
    if (rule.setting === "base_label_halo" && v) {
      return withOpacity(v, state.base_label_halo_opacity);
    }
    return v || null;
  }

}