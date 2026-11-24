'use strict';

const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('public/home', { title: res.locals.site.name, layout: 'layouts/public' });
});

module.exports = router;
