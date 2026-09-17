import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveParticles } from '../src/renderer/core/korean.mjs';

test('object particles follow the final consonant', () => {
  // 리, 기 and 씨 end without a final consonant and take 를; 몽 ends in ㅇ
  // and takes 을.
  assert.equal(resolveParticles('파이리을(를) 선택했다!'), '파이리를 선택했다!');
  assert.equal(resolveParticles('꼬부기을(를) 선택했다!'), '꼬부기를 선택했다!');
  assert.equal(resolveParticles('리자몽을(를) 선택했다!'), '리자몽을 선택했다!');
  assert.equal(resolveParticles('이상해씨을(를) 선택했다!'), '이상해씨를 선택했다!');
});

test('subject and topic particles agree too', () => {
  assert.equal(resolveParticles('리자몽이(가) 나타났다!'), '리자몽이 나타났다!');
  assert.equal(resolveParticles('파이리이(가) 나타났다!'), '파이리가 나타났다!');
  assert.equal(resolveParticles('리자몽은(는) 쓰러졌다!'), '리자몽은 쓰러졌다!');
  assert.equal(resolveParticles('파이리은(는) 쓰러졌다!'), '파이리는 쓰러졌다!');
  assert.equal(resolveParticles('리자몽과(와) 함께'), '리자몽과 함께');
  assert.equal(resolveParticles('파이리과(와) 함께'), '파이리와 함께');
});

test('으로/로 treats a final ㄹ as no final consonant', () => {
  assert.equal(resolveParticles('리자몽으로(로) 변경했다!'), '리자몽으로 변경했다!');
  assert.equal(resolveParticles('파이리으로(로) 변경했다!'), '파이리로 변경했다!');
  // 이글이글 ends in ㄹ, which takes the bare 로.
  assert.equal(resolveParticles('이글이글으로(로) 변경'), '이글이글로 변경');
});

test('a non-Hangul word before the particle keeps the written form', () => {
  assert.equal(resolveParticles('Pikachu을(를) 선택'), 'Pikachu을(를) 선택');
  assert.equal(resolveParticles('을(를) 선택'), '을(를) 선택');
});

test('several particles in one sentence are each resolved', () => {
  assert.equal(
    resolveParticles('리자몽은(는) 파이리을(를) 이겼다!'),
    '리자몽은 파이리를 이겼다!',
  );
});
