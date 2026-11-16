import initialisePopup from "@flourish/info-popup";
// import { createLegendContainer, createDiscreteColorLegend } from "@flourish/legend";
import initialisePopup from "@flourish/info-popup";
import { createDiscreteColorLegend } from "@flourish/legend";

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
  point_blend: "normal",
  point_scale_with_zoom: false,
  point_scale_factor: 2,
  point_min_zoom: 0,
  point_max_zoom: 24,
  point_outline_width: 1,
  point_outline_color: "#ffffff",
  point_outline_opacity: 1,
  category_colors: ["#1D6996", "#EDAD08", "#0F8554", "#CC503E", "#5F4690", "#38A6A5"],
  color_overrides: "Historic Landmark: #990F4B",
  search_placeholder: "Search locations…",
  search_zoom: 12,
  popup: {},
  legend_position: "bottom-left",
  legend_filter: true,
  legend_container: {},
  legend_categorical: {},
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
var legendContainer, legendCategorical;
var hiddenCategories = {};

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

  safely("legend setup", initLegend);
  initSearch();
}

// Run a step; if it throws, log which step failed and carry on
function safely(label, fn) {
  try { fn(); } catch (e) { console.error("[" + label + "]", e); }
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

  safely("base palette", applyBasePalette);

  // Points first, so nothing below can stop them from drawing
  map.getSource("points").setData({ type: "FeatureCollection", features: buildFeatures() });
  map.setPaintProperty("points", "circle-radius", radiusValue());
  map.setPaintProperty("points", "circle-opacity", state.point_opacity);
  map.setLayerZoomRange("points", state.point_min_zoom, state.point_max_zoom);
  map.setPaintProperty("points", "circle-color", colorExpression());
  map.setPaintProperty("points", "circle-stroke-width", state.point_outline_width);
  map.setPaintProperty("points", "circle-stroke-color", state.point_outline_color);
  map.setPaintProperty("points", "circle-stroke-opacity", state.point_outline_opacity);
  document.getElementById("search-input").placeholder = state.search_placeholder;

  safely("legend", updateLegend);
  applyCategoryFilter(); // after the legend, which tidies up hidden categories

  safely("annotations", renderAnnotations);
  safely("popup", function () {
    popup
      .setColumnNames(rows().column_names || {})
      .hideColumnNames(["lat", "lon"])
      .update();
  });

  applyBlendMode(); // must stay last
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
      properties: cleanHex(row.color)
        ? { idx: i, category: row.category || "", color: cleanHex(row.color) }
        : { idx: i, category: row.category || "" }
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
  var byCategory = "#888888";
  if (cats.length) {
    byCategory = ["match", ["get", "category"]];
    cats.forEach(function (c) { byCategory.push(c, colors[c]); });
    byCategory.push("#888888");
  }
  // Use the row's own color if it has one, otherwise the category color
  return ["to-color", ["get", "color"], byCategory];
}

function cleanHex(value) {
  var v = (value || "").trim();
  if (!v) return null;
  if (v[0] !== "#") v = "#" + v;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : null;
}

// function colorExpression() {
//   var colors = categoryColors();
//   var cats = Object.keys(colors);
//   if (!cats.length) return "#888888";
//   var expr = ["match", ["get", "category"]];
//   cats.forEach(function (c) { expr.push(c, colors[c]); });
//   expr.push("#888888"); // fallback
//   return expr;
// }

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
      if (coords(row) && name.includes(q) && !hiddenCategories[row.category || ""]) {
        matches.push({ row: row, idx: idx, pos: name.indexOf(q) });
      }
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

// ---------- legend ----------

function initLegend() {
  legendCategorical = createDiscreteColorLegend(state.legend_categorical);
  legendCategorical.appendTo(document.getElementById("legend"));

  legendCategorical.on("click", function (d) {
    if (!state.legend_filter) return;
    if (hiddenCategories[d.label]) delete hiddenCategories[d.label];
    else hiddenCategories[d.label] = true;
    popup.clickout(); // close a popup that may belong to a now-hidden point
    update();
  });
}

function legendItems() {
  var palette = categoryColors();
  var seen = {};
  var items = [];
  rows().forEach(function (row) {
    var cat = row.category || "";
    if (!cat || seen[cat]) return;
    seen[cat] = true;
    items.push({ label: cat, color: cleanHex(row.color) || palette[cat] });
  });
  return items;
}

function updateLegend() {
  var holder = document.getElementById("legend");
  var items = legendItems();
  holder.className = "map-legend pos-" + state.legend_position + (state.legend_filter ? " filterable" : "");
  holder.style.display = items.length ? "" : "none";

  // Forget hidden categories that no longer exist in the data
  Object.keys(hiddenCategories).forEach(function (c) {
    if (!items.some(function (it) { return it.label === c; })) delete hiddenCategories[c];
  });
  if (!state.legend_filter) hiddenCategories = {};

  legendCategorical
    .data(items)
    .filtered(Object.keys(hiddenCategories))
    .update();
}

function applyCategoryFilter() {
  var hidden = Object.keys(hiddenCategories);
  map.setFilter("points", hidden.length
    ? ["!", ["in", ["get", "category"], ["literal", hidden]]]
    : null);
}


// ---------- multiply blend mode ----------

var MULTIPLY_VS = [
  "attribute vec2 a_center;",   // point position in screen pixels
  "attribute vec2 a_corner;",   // corner of the square around the point (-1..1)
  "attribute vec3 a_color;",
  "uniform vec2 u_viewport;",   // map size in screen pixels
  "uniform float u_radius;",    // outer radius incl. outline
  "varying vec2 v_offset;",
  "varying vec3 v_color;",
  "void main() {",
  "  vec2 offset = a_corner * (u_radius + 1.0);",
  "  vec2 clip = (a_center + offset) / u_viewport * 2.0 - 1.0;",
  "  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);",
  "  v_offset = offset;",
  "  v_color = a_color;",
  "}"
].join("\n");

var MULTIPLY_FS = [
  "precision highp float;",
  "uniform float u_radius;",
  "uniform float u_stroke_width;",
  "uniform vec3 u_stroke_color;",
  "uniform float u_opacity;",
  "uniform float u_stroke_opacity;",
  "varying vec2 v_offset;",
  "varying vec3 v_color;",
  "void main() {",
  "  float d = length(v_offset);",
  "  float outer = 1.0 - smoothstep(u_radius - 0.5, u_radius + 0.5, d);",   // soft circle edge
  "  if (outer <= 0.0) discard;",
  "  float fillR = u_radius - u_stroke_width;",
  "  float inFill = 1.0 - smoothstep(fillR - 0.5, fillR + 0.5, d);",
  "  vec3 col = mix(u_stroke_color, v_color, inFill);",
  "  float a = outer * mix(u_stroke_opacity, u_opacity, inFill);",
  "  gl_FragColor = vec4(col * a, a);",                                      // premultiplied
  "}"
].join("\n");

var CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]; // two triangles = one square

function applyBlendMode() {
  var multiply = state.point_blend === "multiply";
  var hasLayer = !!map.getLayer("points-multiply");
  if (multiply && !hasLayer) map.addLayer(createMultiplyLayer());
  if (!multiply && hasLayer) map.removeLayer("points-multiply");
  // In multiply mode the regular layer stays for hover/click/filtering but draws nothing
  map.setPaintProperty("points", "circle-opacity", multiply ? 0 : state.point_opacity);
  map.setPaintProperty("points", "circle-stroke-opacity", multiply ? 0 : state.point_outline_opacity);
  if (multiply) map.triggerRepaint();
}

function createMultiplyLayer() {
  var program, buffer, vao;
  var loc = {};
  return {
    id: "points-multiply",
    type: "custom",
    renderingMode: "2d",

    onAdd: function (m, gl) {
      program = linkProgram(gl, MULTIPLY_VS, MULTIPLY_FS);
      buffer = gl.createBuffer();
      if (gl.createVertexArray) vao = gl.createVertexArray();
      ["a_center", "a_corner", "a_color"].forEach(function (n) { loc[n] = gl.getAttribLocation(program, n); });
      ["u_viewport", "u_radius", "u_stroke_width", "u_stroke_color", "u_opacity", "u_stroke_opacity"]
        .forEach(function (n) { loc[n] = gl.getUniformLocation(program, n); });
    },

    onRemove: function (m, gl) {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
    },

    render: function (gl) {
      var zoom = map.getZoom();
      if (zoom < state.point_min_zoom || zoom >= state.point_max_zoom) return;
      var verts = multiplyVertices();
      if (!verts.length) return;

      if (vao) gl.bindVertexArray(vao);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

      var stride = 7 * 4;
      gl.enableVertexAttribArray(loc.a_center);
      gl.vertexAttribPointer(loc.a_center, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(loc.a_corner);
      gl.vertexAttribPointer(loc.a_corner, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(loc.a_color);
      gl.vertexAttribPointer(loc.a_color, 3, gl.FLOAT, false, stride, 16);

      var canvas = map.getCanvas();
      var stroke = hexToRgb01(state.point_outline_color);
      gl.uniform2f(loc.u_viewport, canvas.clientWidth, canvas.clientHeight);
      var strokeW = +state.point_outline_width || 0;
      gl.uniform1f(loc.u_radius, currentRadius() + strokeW);
      gl.uniform1f(loc.u_stroke_width, strokeW);
      gl.uniform3f(loc.u_stroke_color, stroke[0], stroke[1], stroke[2]);
      gl.uniform1f(loc.u_opacity, state.point_opacity);
      gl.uniform1f(loc.u_stroke_opacity, state.point_outline_opacity);

      // Multiply: result = base × (1 − a + a × color)
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, verts.length / 7);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // back to MapLibre's normal blending

      if (vao) {
        gl.bindVertexArray(null);
      } else {
        gl.disableVertexAttribArray(loc.a_center);
        gl.disableVertexAttribArray(loc.a_corner);
        gl.disableVertexAttribArray(loc.a_color);
      }
    }
  };
}

function multiplyVertices() {
  var colors = categoryColors();
  var out = [];
  rows().forEach(function (row) {
    var c = coords(row);
    var cat = row.category || "";
    if (!c || hiddenCategories[cat]) return;
    var p = map.project(c);
    var rgb = hexToRgb01(cleanHex(row.color) || colors[cat] || "#888888");
    for (var k = 0; k < 12; k += 2) {
      out.push(p.x, p.y, CORNERS[k], CORNERS[k + 1], rgb[0], rgb[1], rgb[2]);
    }
  });
  return new Float32Array(out);
}

function currentRadius() {
  var r = +state.point_radius || 6;
  if (!state.point_scale_with_zoom) return r;
  var t = Math.min(Math.max((map.getZoom() - 2) / 12, 0), 1); // same 2 → 14 ramp as radiusValue()
  return r + (r * (+state.point_scale_factor || 1) - r) * t;
}

function hexToRgb01(hex) {
  var h = (hex || "#888888").replace("#", "");
  if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
  var n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function linkProgram(gl, vsSource, fsSource) {
  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  var p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
  return p;
}