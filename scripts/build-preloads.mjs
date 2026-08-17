import path from 'node:path';
import webpack from 'webpack';

const stats = await new Promise((resolve, reject) => {
	webpack({
		mode: 'none',
		target: ['web', 'es2022'],
		entry: {
			browser: './dist-js/browser.js',
			'browser-call': './dist-js/browser-call.js',
		},
		externals: {
			electron: 'commonjs electron',
		},
		output: {
			path: path.resolve('dist-js/preload'),
			filename: '[name].js',
		},
		plugins: [
			new webpack.DefinePlugin({
				'process.type': JSON.stringify('renderer'),
			}),
		],
	}, (error, result) => {
		if (error) {
			reject(error);
			return;
		}

		resolve(result);
	});
});

if (!stats || stats.hasErrors()) {
	throw new Error(stats?.toString({all: false, errors: true}) ?? 'Preload bundling failed');
}
