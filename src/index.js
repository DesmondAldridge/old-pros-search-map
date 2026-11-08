import initialisePopup from "@flourish/info-popup";

export var data = {};

export var state = {
  map_style: "https://tiles.openfreemap.org/styles/liberty",
  start_lat: 30,
  start_lon: 0,
  start_zoom: 1.5,
  point_radius: 6,
  category_colors: ["#1D6996", "#EDAD08", "#0F8554", "#CC503E", "#5F4690", "#38A6A5"],
  color_overrides: "Historic Landmark: #990F4B",
  search_placeholder: "Search locations…",
  search_zoom: 12,
  popup: {}
};

var map, popup, currentStyle;
var hoveredIdx = null;
var mapReady = false;

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
  map.getSource("points").setData({ type: "FeatureCollection", features: buildFeatures() });
  map.setPaintProperty("points", "circle-radius", state.point_radius);
  map.setPaintProperty("points", "circle-color", colorExpression());
  document.getElementById("search-input").placeholder = state.search_placeholder;

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

function addPointLayer() {
  map.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "points",
    type: "circle",
    source: "points",
    paint: {
      "circle-radius": state.point_radius,
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